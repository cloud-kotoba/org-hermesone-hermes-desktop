export default {
  title: "プロバイダ",
  subtitle: "LLM プロバイダ、API キー、認証情報プールを設定します",
  oauth: {
    sectionTitle: "サブスクリプション / OAuth プラン",
    sectionHint:
      "API キーの代わりにプロバイダのサブスクリプションでサインインします。認証はブラウザで行われます。",
    signIn: "サインイン",
    runningHint: "以下の手順に従ってサインインを完了してください。",
    successHint: "サインインに成功しました。このプロバイダを選択できます。",
    failed: "サインインに失敗しました。",
    codexDesc: "ChatGPT Codex プランを使用",
    xaiDesc: "xAI Grok のサブスクリプションを使用",
    qwenDesc: "Qwen のサブスクリプションを使用",
    geminiDesc: "Google AI Pro / Gemini プランを使用",
    minimaxDesc: "MiniMax のサブスクリプションを使用",
  },
  kotobaAccount: {
    sectionTitle: "Kotoba Cloud アカウント",
    sectionHint:
      "ブラウザで Kotoba Cloud にサインイン（Passkey）し、kotoba.cloud/account で personal API token を発行して、ここに接続します。この profile の KOTOBA_API_KEY として保存され、Kotoba Cloud provider とエージェントがそれを使います。",
    signIn: "Kotoba Cloud にサインイン",
    signOut: "接続を解除",
    connected: "接続済み",
    notLive: "トークンが無効です",
    token: "token …{{id}}",
    credits: "${{amount}} ai クレジット",
    creditsTitle:
      "Kotoba Cloud アカウントの ai クレジット残高（GET /v1/billing/status）。kotoba.cloud/billing で追加できます。",
    creditsUnknown: "残高を読めません",
    creditsUnknownTitle:
      "このトークンには billing:read scope が無いので残高は読めません。チャットは使えます。",
    manage: "kotoba.cloud で管理",
    modalTitle: "Kotoba Cloud にサインイン",
    modalHint:
      "1. kotoba.cloud/account を開き Passkey でサインイン。 2. personal API token（kc_pat_…）を発行。 3. 下に貼り付け — 保存前に Kotoba Cloud に照会して確かめます。",
    passkey: "Passkey でサインイン",
    passkeyHint:
      "kotoba.cloud のサインイン画面をウィンドウで開きます。サインインできると、このアプリがそのセッションから自分用の personal API token を発行して保存します — 貼り付けは不要です。",
    passkeyWorking: "サインインのウィンドウを待っています…",
    orPaste: "または自分で発行したトークンを貼り付け",
    openAccount: "kotoba.cloud/account を開く",
    tokenLabel: "Personal API token",
    tokenPlaceholder: "kc_pat_…",
    connect: "接続",
    connecting: "Kotoba Cloud に照会中…",
    successHint: "接続しました。provider として Kotoba Cloud が使えます。",
    failed: "接続できませんでした。",
    gatewayLabel: "Gateway",
    gatewayLocal: "このマシンのローカル Hermes",
    gatewayCloud: "Kotoba Cloud — サンドボックス上のあなた専用 Hermes",
    gatewayRunning: "クラウド gateway 実行中",
    gatewayStarting: "クラウド gateway 起動中…",
    gatewayStopped: "クラウド gateway 停止中",
    gatewaySignedOut: "クラウド gateway を使うには Passkey でサインイン",
    gatewayUnavailable:
      "kotoba.cloud 側の gateway lane がまだ公開されていません",
    gatewayLaunch: "クラウド gateway を起動",
    gatewayLaunchHint:
      "起動・再開 1 回ごとに ai クレジットから定額。稼働中は課金なし。セッションは 3 時間で終了。",
    gatewayOpen: "開く",
    gatewayStop: "停止",
    gatewayLaunching: "起動中…",
    gatewayOpenHint:
      "クラウド上の Hermes（Web UI 全体）をウィンドウで開きます。デスクトップ自身のチャットはローカル Hermes のままです。",
  },
} as const;
