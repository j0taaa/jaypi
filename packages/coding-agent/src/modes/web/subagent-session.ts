import { randomUUID } from "node:crypto";
import { HttpError } from "./http.js";
import type {
	Broadcast,
	SubagentSessionData,
	SubagentSessionRequest,
	WebEvent,
	WebRpcCommand,
	WebRpcResponse,
} from "./types.js";

export interface SubagentAgentConfig {
	id?: string;
	name: string;
	description?: string;
	systemPrompt: string;
	tools?: string[];
}

export interface SubagentRpc {
	readonly pid?: number;
	send<T extends WebRpcResponse = WebRpcResponse>(command: WebRpcCommand, timeoutMs?: number): Promise<T>;
	stop(signal?: NodeJS.Signals): void;
}

export type SubagentRpcFactory = (broadcast: Broadcast, cwd: string, extraEnv: NodeJS.ProcessEnv) => SubagentRpc;

export class SubagentSessionManager {
	private agents: SubagentAgentConfig[] = [];
	private running = new Map<string, SubagentRpc>();

	constructor(
		private readonly broadcast: Broadcast,
		private readonly createRpc: SubagentRpcFactory,
	) {}

	setAgents(agents: SubagentAgentConfig[]): void {
		this.agents = agents.filter(
			(agent) =>
				typeof agent.name === "string" &&
				agent.name.trim().length > 0 &&
				typeof agent.systemPrompt === "string" &&
				agent.systemPrompt.trim().length > 0,
		);
	}

	resolveAgent(agentRef: unknown): SubagentAgentConfig {
		const needle = typeof agentRef === "string" ? agentRef.trim() : "";
		if (!needle) throw new HttpError(400, "Missing agent");
		const agent = this.agents.find((candidate) => candidate.id === needle || candidate.name === needle);
		if (!agent) throw new HttpError(400, `Unknown agent: ${needle}`);
		return agent;
	}

	async run(
		request: SubagentSessionRequest,
		cwd: string,
		extraEnv: NodeJS.ProcessEnv = {},
	): Promise<SubagentSessionData> {
		const agent = this.resolveAgent(request.agent);
		const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
		if (!prompt) throw new HttpError(400, "Missing prompt");

		const id = `subagent_${randomUUID()}`;
		let sessionFile = "";
		let sessionId = "";
		let finished = false;
		let settled = false;
		let resolveDone: (() => void) | undefined;
		let rejectDone: ((error: Error) => void) | undefined;
		const done = new Promise<void>((resolve, reject) => {
			resolveDone = resolve;
			rejectDone = reject;
		});
		const timeout = setTimeout(
			() => {
				if (settled) return;
				rejectDone?.(new Error("Subagent timed out"));
			},
			10 * 60 * 1000,
		);

		const childBroadcast: Broadcast = (event: WebEvent) => {
			const eventType = typeof event.type === "string" ? event.type : "";
			if (eventType === "agent_start") {
				this.broadcastRun("subagent_update", { id, status: "running", message: "running" });
			} else if (eventType === "message_update") {
				this.broadcastRun("subagent_update", { id, status: "running", message: "working" });
			} else if (eventType === "agent_end") {
				finished = true;
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					resolveDone?.();
				}
			} else if (eventType === "rpc_exit" && !finished && !settled) {
				settled = true;
				clearTimeout(timeout);
				rejectDone?.(new Error("Subagent RPC exited before finishing"));
			}
		};

		const rpc = this.createRpc(childBroadcast, cwd, extraEnv);
		this.running.set(id, rpc);
		let runData: SubagentSessionData | null = null;
		try {
			await this.expectSuccess(rpc.send({ type: "new_session" }, 120000));
			await this.expectSuccess(rpc.send({ type: "set_active_tools", tools: agent.tools ?? [] }, 120000));
			await this.expectSuccess(rpc.send({ type: "set_system_prompt", systemPrompt: agent.systemPrompt }, 120000));
			const state = await this.expectSuccess<
				WebRpcResponse & { data?: { sessionFile?: string; sessionId?: string } }
			>(rpc.send({ type: "get_state" }, 120000));
			sessionFile = state.data?.sessionFile ?? "";
			sessionId = state.data?.sessionId ?? "";
			runData = {
				id,
				agent: agent.name,
				prompt,
				cwd,
				sessionFile,
				sessionId,
				answer: "",
				status: "running",
			};
			this.broadcastRun("subagent_start", runData);
			await this.expectSuccess(rpc.send({ type: "set_session_name", name: `Subagent: ${agent.name}` }, 120000));
			await this.expectSuccess(rpc.send({ type: "prompt", message: prompt }, 120000));
			await done;
			const answerResponse = await this.expectSuccess<WebRpcResponse & { data?: { text?: string } }>(
				rpc.send({ type: "get_last_assistant_text" }, 120000),
			);
			runData = {
				...runData,
				answer: answerResponse.data?.text ?? "",
				status: "done",
			};
			this.broadcastRun("subagent_end", runData);
			return runData;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const data: SubagentSessionData = {
				id,
				agent: agent.name,
				prompt,
				cwd,
				sessionFile,
				sessionId,
				answer: "",
				status: "error",
				error: message,
			};
			this.broadcastRun("subagent_error", runData ? { ...runData, status: "error", error: message } : data);
			throw new HttpError(500, message);
		} finally {
			clearTimeout(timeout);
			this.running.delete(id);
			rpc.stop();
		}
	}

	stopAll(): void {
		for (const rpc of this.running.values()) rpc.stop();
		this.running.clear();
	}

	private async expectSuccess<T extends WebRpcResponse>(promise: Promise<T>): Promise<T & { success: true }> {
		const response = await promise;
		if (!response.success) throw new Error(response.error);
		return response as T & { success: true };
	}

	private broadcastRun(
		type: "subagent_start" | "subagent_update" | "subagent_end" | "subagent_error",
		data: Partial<SubagentSessionData> & { id: string },
	): void {
		this.broadcast({ type, data });
	}
}
