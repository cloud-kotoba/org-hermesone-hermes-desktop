"""Build the profile registry for the murakumo lease control plane.

    python tools/lease_plan.py --home ~/.hermes --workstation did:key:... \\
        --canary 20 --canary-node did:key:...            # dry run: print the plan
    ... --apply --lease-url https://murakumo.cloud        # PUT it (admin token
                                                          # in MURAKUMO_PROFILES_ADMIN_TOKEN)

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


def apply(lease_url, registry):
    token = os.environ.get("MURAKUMO_PROFILES_ADMIN_TOKEN")
    if not token:
        raise SystemExit("MURAKUMO_PROFILES_ADMIN_TOKEN is required for --apply")
    req = urllib.request.Request(
        lease_url.rstrip("/") + "/api/profiles/registry", method="PUT",
        data=json.dumps({"profiles": registry}).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--home", default=os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes")))
    p.add_argument("--workstation", required=True, help="did:key of the workstation's node")
    p.add_argument("--canary", type=int, default=20)
    p.add_argument("--canary-node", help="did:key of the canary node (omit: no canaries)")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--lease-url", default=os.environ.get("KOTOBA_LEASE_URL"))
    p.add_argument("--json", action="store_true", help="print the full registry")
    a = p.parse_args(argv)
    result = plan(a.home, a.workstation, a.canary, a.canary_node)
    if a.json:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result["summary"]))
        for name in result["canaries"]:
            print("canary", name)
    if a.apply:
        if not a.lease_url:
            raise SystemExit("--lease-url (or KOTOBA_LEASE_URL) is required for --apply")
        print(apply(a.lease_url, result["profiles"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
