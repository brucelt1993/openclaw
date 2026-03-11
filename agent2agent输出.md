可以，下面我直接给你“完整改动位置 + 可直接改的代码”。

你这次要改的核心目标是：

让 `sessions_send` 在 A2A ping-pong 的每一轮内部协商后，都把该轮内容投递到目标 agent 对应的外部渠道，而不是只在最后 announce 一次。

我建议改 4 个文件：

- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-tool.ts`
- `src/config/zod-schema.session.ts`
- `src/config/types.base.ts`

如果你愿意更稳一点，还可以顺手补测试，但这 4 个文件是功能最小闭环。

---

## 一、`src/config/types.base.ts`

位置：`SessionConfig` 里的 `agentToAgent` 配置块。

你现在原来是：

ts

`agentToAgent?: {
  /** Max ping-pong turns between requester/target (0–5). Default: 5. */
  maxPingPongTurns?: number;
};`

改成：

ts

`agentToAgent?: {
  /** Max ping-pong turns between requester/target (0–5). Default: 5. */
  maxPingPongTurns?: number;
  /** Whether to broadcast each ping-pong reply to the target external channel. Default: false. */
  broadcastPingPong?: boolean;
};`

---

## 二、`src/config/zod-schema.session.ts`

位置：`SessionSchema` 里的 `agentToAgent` schema。

你现在原来是：

ts

`agentToAgent: z
  .object({
    maxPingPongTurns: z.number().int().min(0).max(5).optional(),
  })
  .strict()
  .optional(),`

改成：

ts

`agentToAgent: z
  .object({
    maxPingPongTurns: z.number().int().min(0).max(5).optional(),
    broadcastPingPong: z.boolean().optional(),
  })
  .strict()
  .optional(),`

---

## 三、`src/agents/tools/sessions-send-tool.ts`

### 1）读取配置

位置：靠近这里：

ts

`const requesterSessionKey = opts?.agentSessionKey;
const requesterChannel = opts?.agentChannel;
const maxPingPongTurns = resolvePingPongTurns(cfg);
const delivery = { status: "pending", mode: "announce" as const };`

改成：

ts

`const requesterSessionKey = opts?.agentSessionKey;
const requesterChannel = opts?.agentChannel;
const maxPingPongTurns = resolvePingPongTurns(cfg);
const broadcastPingPong = cfg?.session?.agentToAgent?.broadcastPingPong === true;
const delivery = {
  status: "pending",
  mode: broadcastPingPong ? ("ping_pong+announce" as const) : ("announce" as const),
};`

---

### 2）把新参数传进 A2A flow

位置：`startA2AFlow` 里。

原来是：

ts

`const startA2AFlow = (roundOneReply?: string, waitRunId?: string) => {
  void runSessionsSendA2AFlow({
    targetSessionKey: resolvedKey,
    displayKey,
    message,
    announceTimeoutMs,
    maxPingPongTurns,
    requesterSessionKey,
    requesterChannel,
    roundOneReply,
    waitRunId,
  });
};`

改成：

ts

`const startA2AFlow = (roundOneReply?: string, waitRunId?: string) => {
  void runSessionsSendA2AFlow({
    targetSessionKey: resolvedKey,
    displayKey,
    message,
    announceTimeoutMs,
    maxPingPongTurns,
    broadcastPingPong,
    requesterSessionKey,
    requesterChannel,
    roundOneReply,
    waitRunId,
  });
};`

---

## 四、`src/agents/tools/sessions-send-tool.a2a.ts`

这是主改动文件。

---

### 1）给 params 增加新字段

位置：函数参数类型定义里。

原来是：

ts

`export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}) {`

改成：

ts

`export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  broadcastPingPong?: boolean;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}) {`

---

### 2）抽一个统一发送到渠道的方法

位置：在

ts

`const targetChannel = announceTarget?.channel ?? "unknown";`

下面，加一个局部函数。

新增：

ts

`const sendToAnnounceTarget = async (message: string, phase: "ping_pong" | "announce", turn?: number) => {
  if (!announceTarget || !message.trim()) {
    return;
  }
  try {
    await callGateway({
      method: "send",
      params: {
        to: announceTarget.to,
        message: message.trim(),
        channel: announceTarget.channel,
        accountId: announceTarget.accountId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send external delivery failed", {
      runId: runContextId,
      phase,
      turn,
      channel: announceTarget.channel,
      to: announceTarget.to,
      error: formatErrorMessage(err),
    });
  }
};`

这样后面 ping-pong 和 announce 都走同一套发信逻辑。

---

### 3）在 ping-pong 循环里，每轮回复后立即外发

位置：for 循环里，当前代码是：

ts

`if (!replyText || isReplySkip(replyText)) {
  break;
}
latestReply = replyText;
incomingMessage = replyText;
const swap = currentSessionKey;
currentSessionKey = nextSessionKey;
nextSessionKey = swap;`

改成：

ts

`if (!replyText || isReplySkip(replyText)) {
  break;
}

latestReply = replyText;
incomingMessage = replyText;

if (params.broadcastPingPong) {
  const speaker =
    currentSessionKey === params.requesterSessionKey ? "requester" : "target";
  const pingPongMessage = [
    `[A2A ping-pong][turn ${turn}]`,
    `speaker: ${speaker}`,
    `session: ${currentSessionKey}`,
    "",
    replyText.trim(),
  ].join("\n");
  await sendToAnnounceTarget(pingPongMessage, "ping_pong", turn);
}

const swap = currentSessionKey;
currentSessionKey = nextSessionKey;
nextSessionKey = swap;`

这里的效果是：

- 每轮 `runAgentStep` 出了有效回复
- 且不是 `REPLY_SKIP`
- 且 `broadcastPingPong=true`
- 就立即发到目标外部渠道

---

### 4）把最后 announce 的发送逻辑复用掉

你现在最后是：

ts

`if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
  try {
    await callGateway({
      method: "send",
      params: {
        to: announceTarget.to,
        message: announceReply.trim(),
        channel: announceTarget.channel,
        accountId: announceTarget.accountId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send announce delivery failed", {
      runId: runContextId,
      channel: announceTarget.channel,
      to: announceTarget.to,
      error: formatErrorMessage(err),
    });
  }
}`

改成：

ts

`if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
  await sendToAnnounceTarget(announceReply, "announce");
}`

这样逻辑更干净。

---

## 五、改完后的 `sessions-send-tool.a2a.ts` 关键片段

为了方便你直接对照，我把核心部分拼一下：

ts

`export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  broadcastPingPong?: boolean;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      const wait = await callGateway<{ status: string }>({
        method: "agent.wait",
        params: {
          runId: params.waitRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });
      if (wait?.status === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      }
    }
    if (!latestReply) {
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    const sendToAnnounceTarget = async (
      message: string,
      phase: "ping_pong" | "announce",
      turn?: number,
    ) => {
      if (!announceTarget || !message.trim()) {
        return;
      }
      try {
        await callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: message.trim(),
            channel: announceTarget.channel,
            accountId: announceTarget.accountId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions_send external delivery failed", {
          runId: runContextId,
          phase,
          turn,
          channel: announceTarget.channel,
          to: announceTarget.to,
          error: formatErrorMessage(err),
        });
      }
    };

    if (
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        const replyText = await runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText)) {
          break;
        }

        latestReply = replyText;
        incomingMessage = replyText;

        if (params.broadcastPingPong) {
          const speaker =
            currentSessionKey === params.requesterSessionKey ? "requester" : "target";
          const pingPongMessage = [
            `[A2A ping-pong][turn ${turn}]`,
            `speaker: ${speaker}`,
            `session: ${currentSessionKey}`,
            "",
            replyText.trim(),
          ].join("\n");
          await sendToAnnounceTarget(pingPongMessage, "ping_pong", turn);
        }

        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });
    const announceReply = await runAgentStep({
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: AGENT_LANE_NESTED,
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
    });
    if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
      await sendToAnnounceTarget(announceReply, "announce");
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}`

---

## 六、配置怎么写

改完以后，你的配置可以这样开：

yaml

`session:
  agentToAgent:
    maxPingPongTurns: 5
    broadcastPingPong: true`

如果不写，默认就是 `false`，行为和现在一致。

---

## 七、如果你是 npm 部署，能不能直接改？

可以，但要分两种情况：

### 方式 1：直接改安装产物

如果你是全局 npm 安装，通常代码在：

- Linux: 可能类似`/usr/lib/node_modules/openclaw/`
- 或者`/usr/local/lib/node_modules/openclaw/`

你需要改的是编译后的 `dist`/产物文件，不一定是 `src/*.ts`。

也就是说：

- 你现在我上面给的是 **源码改法**
- 如果你本机只有 npm 安装包，没有源码仓库
- 那你需要改编译后的 js 文件，而不是 ts

### 方式 2：拉源码重新构建

更稳：

- fork / clone 仓库
- 按源码改
- `pnpm install`
- `pnpm build`
- 用你自己的构建结果替换运行版本

这个更推荐，不然下次 npm 升级就没了。

---

## 八、如果你要改 npm 安装后的 js，我建议你优先找这两个产物文件

一般重点会落在：

- `.../dist/agents/tools/sessions-send-tool.a2a.js`
- `.../dist/agents/tools/sessions-send-tool.js`

如果配置 schema 只是你自己写 yaml，不一定非得立刻补 schema；但如果 OpenClaw 启动时会校验配置，那 `zod-schema.session.js` 和对应类型产物也得一起改。

所以：

- **最小热补丁**：先改两个 runtime js 文件
- **完整正规改法**：源码 4 文件一起改再 build

---

## 九、我建议你实际先这么做

如果你现在只是想先验证功能：

先只做运行时最小闭环：

- `sessions-send-tool.a2a.*`
- `sessions-send-tool.*`

把 `broadcastPingPong` 暂时写死成 `true`

等验证飞书群里效果 OK，再补：

- `zod-schema.session.ts`
- `types.base.ts`

这样试错最快。

---

如果你愿意，我下一条可以继续直接给你一版：

**“npm 安装产物里的 JS 改法”**

也就是不按 TS 源码说，而是按你部署后机器上能直接改的 `.js` 文件来给。
