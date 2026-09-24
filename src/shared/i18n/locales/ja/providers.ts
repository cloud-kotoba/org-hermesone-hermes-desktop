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
      "ブラウザで Kotoba Cloud にサインイン（Passkey）し、kotoba.cloud/account で personal API token を発行して、ここに接続します。この profile の KOTOBA_API_KEY として（.env ではなく OS のキーチェーンに）保存され、Kotoba Cloud provider とエージェントがそれを使います。",
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
      "kotoba.cloud で使っている Passkey で、いつものブラウザからサインインします。kotoba.cloud/account で発行した personal API token（kc_pat_…）を貼り付けることもできます — 保存前に Kotoba Cloud に照会して確かめます。",
    passkey: "ブラウザでサインイン（Passkey）",
    passkeyHint:
      "既定のブラウザで kotoba.cloud を開きます。そこで Passkey でサインインし、この画面のコードを承認すると、このアプリ専用のトークン（チャット・残高・エージェント・組織・ホストされた Hermes）が届きます — 貼り付けは不要です。",
    passkeyWorking: "ブラウザでの承認を待っています…",
    deviceHint:
      "開いたブラウザでこのコードを承認してください（求められたら先に Passkey でサインイン）。ブラウザ側のコードがこの画面と同じか確かめてください。",
    copyCode: "コードをコピー",
    copied: "コピーしました",
    reopenBrowser: "ブラウザをもう一度開く",
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
    contextLabel: "請求先",
    contextPersonal: "個人",
    contextOrg: "{{handle}}（{{role}}）",
    contextHint:
      "残高をどの台帳で表示するか: 個人のクレジット、または組織のもの。メンバーと席数は kotoba.cloud で管理します。",
    orgsLoading: "組織を読み込み中…",
    orgsReconnect: "組織を表示するには再接続してください",
    orgsReconnectTitle:
      "このトークンは org:read scope ができる前に発行されました。Passkey でもう一度サインインすると、組織を読めるトークンが発行されます。",
    orgsReconnectAction: "再接続",
    orgsUnavailable: "組織機能は利用できません",
    orgsUnavailableTitle:
      "kotoba.cloud はまだ組織メンバーシップを提供していません（GET /v1/org/memberships が 404）。",
    orgsNone: "所属している組織はありません",
    orgsError: "組織を読み込めませんでした",
    orgRoleInsufficientTitle:
      "この組織の残高を読めるのは owner・admin・billing のメンバーだけです。",
    storagePlaintext: "平文で保存",
    storagePlaintextTitle:
      "OS のキーチェーンが使えないため、トークンはこの profile の .env に平文で保存されています。",
  },
} as const;
