"""Build, sign and publish the placement manifest (no central store).

    python tools/placement_plan.py --home ~/.hermes \\
        --node did:key:WS=http://100.108.223.94:8642:anonymous,attested \\
        --node did:key:BJ=http://100.75.169.8:8642:anonymous \\
        --workstation did:key:WS --canary 20 --canary-node did:key:BJ   # dry run
    ... --apply http://127.0.0.1:8642      # PUT /v1/placement on that gateway
                                           # (bearer API_SERVER_KEY from HERMES_HOME/.env)

The manifest is signed with the operator key (~/.kotoba/operator.key, created
on first use; its did is what nodes trust via --operator-did) and carries a
millisecond version, so a newer plan always supersedes an older one.

Every profile is pinned to the workstation except the canaries, which are
pinned to the canary node. Canaries are chosen to be safe to move first: no
secrets in the profile's own .env, every enabled job delivers "local", at
least one enabled job, and the lowest measured cost (busy seconds per day from
cron/executions.db). Profiles with secrets are registered as "attested" so the
control plane never places them on an anonymous node.
"""

import argparse
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ROOT, ".deps"), ROOT]

import hy  # noqa: E402,F401

from kotoba_gateway.shard import cost_report, job_list, profile_homes  # noqa: E402

SECRET_LINE = re.compile(r"^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*\s*=\s*\S", re.M)
PROFILE_ID = re.compile(r"^[a-z0-9_][a-z0-9_-]{0,63}$")


def has_secrets(home):
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8") as f:
            return bool(SECRET_LINE.search(f.read()))
    except OSError:
        return False


def enabled_jobs(home):
    try:
        with open(os.path.join(home, "cron", "jobs.json"), encoding="utf-8") as f:
            return [j for j in job_list(json.load(f)) if j.get("enabled", True)]
    except (OSError, ValueError):
        return []


def plan(home, workstation, canary_n, canary_node):
    full = cost_report(home, nodes=1, top=None)
    costs = {p["profile"]: p["busy_seconds_per_day"] for p in full["costliest"]}
    profiles, candidates = [], []
    for name, phome in profile_homes(home):
        if not PROFILE_ID.match(name):
            continue
        secret = has_secrets(phome)
        jobs = enabled_jobs(phome)
        local_only = bool(jobs) and all(str(j.get("deliver") or "local") == "local" for j in jobs)
        record = {"id": name, "residency": "attested" if secret else "anonymous",
                  "pin": workstation, "caps": ["python3"]}
        if name in costs:
            record["cost"] = costs[name]
        profiles.append(record)
        if name != "default" and not secret and local_only:
            candidates.append((costs.get(name, 0.0), name))
    candidates.sort()
    canaries = [name for _cost, name in candidates[:canary_n]] if canary_node else []
    for record in profiles:
        if record["id"] in canaries:
            record["pin"] = canary_node
    return {"profiles": profiles, "canaries": canaries,
            "summary": {"profiles": len(profiles),
                        "attested": sum(1 for p in profiles if p["residency"] == "attested"),
                        "canary_candidates": len(candidates),
                        "canaries": len(canaries),
                        "history_profiles": full["profiles_with_history"]}}


def parse_node(spec):
    """did=url:residency1,residency2 -> manifest node entry."""
    did, rest = spec.split("=", 1)
    url, _, residency = rest.rpartition(":") if rest.count(":") > 2 else (rest, "", "")
    return {"did": did, "url": url, "residency": [r for r in residency.split(",") if r] or ["anonymous"],
            "caps": ["python3"]}


def api_key(home):
    key = os.environ.get("API_SERVER_KEY")
    if key:
        return key
    try:
        for line in open(os.path.join(home, ".env"), encoding="utf-8"):
            if line.strip().startswith("API_SERVER_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    raise SystemExit("API_SERVER_KEY not found (env or HERMES_HOME/.env)")


def publish(gateway, home, manifest):
    req = urllib.request.Request(
        gateway.rstrip("/") + "/v1/placement", method="PUT", data=json.dumps(manifest).encode(),
        headers={"authorization": f"Bearer {api_key(home)}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def main(argv=None):
    from kotoba_gateway.identity import NodeIdentity
    from kotoba_gateway.placement import build_manifest

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--home", default=os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes")))
    p.add_argument("--node", action="append", default=[], required=True,
                   help="did=url:residency[,residency] (repeatable)")
    p.add_argument("--workstation", required=True, help="did:key every non-canary profile is pinned to")
    p.add_argument("--canary", type=int, default=20)
    p.add_argument("--canary-node", help="did:key of the canary node (omit: no canaries)")
    p.add_argument("--operator-key", default=os.path.expanduser("~/.kotoba/operator.key"))
    p.add_argument("--write", help="also write the signed manifest to this path")
    p.add_argument("--apply", metavar="GATEWAY_URL", help="PUT the manifest to this gateway")
    p.add_argument("--json", action="store_true", help="print the full manifest")
    a = p.parse_args(argv)

    operator = NodeIdentity.load_or_create(a.operator_key)
    result = plan(a.home, a.workstation, a.canary, a.canary_node)
    manifest = build_manifest(operator, [parse_node(n) for n in a.node], result["profiles"])
    if a.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(json.dumps({**result["summary"], "operator": operator.did, "version": manifest["version"]}))
        for name in result["canaries"]:
            print("canary", name)
    if a.write:
        with open(a.write, "w", encoding="utf-8") as f:
            json.dump(manifest, f)
    if a.apply:
        print(publish(a.apply, a.home, manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
