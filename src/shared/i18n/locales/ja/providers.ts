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
    openAccount: "kotoba.cloud/account を開く",
    tokenLabel: "Personal API token",
    tokenPlaceholder: "kc_pat_…",
    connect: "接続",
    connecting: "Kotoba Cloud に照会中…",
    successHint: "接続しました。provider として Kotoba Cloud が使えます。",
    failed: "接続できませんでした。",
  },
} as const;
