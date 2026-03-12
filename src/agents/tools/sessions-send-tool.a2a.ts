import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

export async function runSessionsSendA2AFlow(params: {
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
  log.info("A2A flow started", {
    runId: runContextId,
    target: params.targetSessionKey,
    requester: params.requesterSessionKey,
    maxPingPongTurns: params.maxPingPongTurns,
    broadcastPingPong: params.broadcastPingPong ?? false,
    hasRoundOneReply: !!params.roundOneReply,
  });
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
      log.info("A2A flow skipped: no initial reply", { runId: runContextId });
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";
    log.info("A2A announce target resolved", {
      runId: runContextId,
      hasTarget: !!announceTarget,
      channel: targetChannel,
    });

    const sendToAnnounceTarget = async (message: string, phase: "ping_pong" | "announce", turn?: number) => {
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
        log.info("A2A external delivery sent", {
          runId: runContextId,
          phase,
          turn,
          channel: announceTarget.channel,
          to: announceTarget.to,
          messageLength: message.trim().length,
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
          log.info("A2A ping-pong ended early", {
            runId: runContextId,
            turn,
            reason: !replyText ? "no_reply" : "reply_skip",
            currentRole,
          });
          break;
        }
        latestReply = replyText;
        incomingMessage = replyText;
        log.info("A2A ping-pong turn completed", {
          runId: runContextId,
          turn,
          maxTurns: params.maxPingPongTurns,
          role: currentRole,
          replyLength: replyText.length,
          broadcastPingPong: !!params.broadcastPingPong,
        });

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
      broadcastPingPong: params.broadcastPingPong,
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
      log.info("A2A announce sending", {
        runId: runContextId,
        channel: targetChannel,
        replyLength: announceReply.trim().length,
      });
      await sendToAnnounceTarget(announceReply, "announce");
    } else {
      log.info("A2A announce skipped", {
        runId: runContextId,
        hasTarget: !!announceTarget,
        hasReply: !!announceReply,
        isSkip: announceReply ? isAnnounceSkip(announceReply) : false,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
