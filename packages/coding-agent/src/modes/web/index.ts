import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { homedir, networkInterfaces } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getProviders } from "@mariozechner/pi-ai";
import { getAgentDir, getAuthPath, getModelsPath } from "../../config.js";
import { AuthStorage } from "../../core/auth-storage.js";
import { estimateContextTokens } from "../../core/compaction/index.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.js";
import { type SessionInfo, SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { assertHostAllowed, parseWebArgs, usage } from "./args.js";
import { assertAuthorized, assertSafeOrigin, requestHasToken, writeAuthRedirect } from "./auth.js";
import { GitProjectManager } from "./git-project.js";
import {
	contentTypeFor,
	HttpError,
	readJsonBody,
	requireNonEmptyString,
	requireString,
	sendError,
	sendJson,
	sendStaticFile,
	sendText,
} from "./http.js";
import { ProgressTrackerManager } from "./progress-tracker.js";
import { groupSessionsByProject } from "./projects.js";
import { RpcBridge } from "./rpc-bridge.js";
import { deleteWebSkill, listWebSkills, writeWebSkill } from "./skills.js";
import { SubagentSessionManager } from "./subagent-session.js";
import { TerminalManager, TerminalUnavailableError } from "./terminal.js";
import type {
	AgentRegistrySyncRequest,
	ApplyAgentRequest,
	AskQuestionAnswer,
	AskQuestionOption,
	AskQuestionRequest,
	GitBranchSwitchRequest,
	GitCommitRequest,
	PreviewTabData,
	PreviewTabRequest,
	ProgressTrackerRequest,
	PromptRequest,
	SetModelRequest,
	SetThinkingRequest,
	SkillWriteRequest,
	SubagentSessionRequest,
	SwitchSessionRequest,
	SystemPromptRequest,
	TerminalInputRequest,
	TerminalResizeRequest,
	WebCommand,
	WebEvent,
	WebOptions,
	WebRpcResponse,
	WebRpcState,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "..", "..", "cli.js");
const sourceWebDir = path.resolve(__dirname, "..", "..", "..", "web");
const distWebDir = path.resolve(__dirname, "..", "..", "web");
const webMainSystemPromptPath = path.join(getAgentDir(), "web-main-system-prompt.txt");

interface PendingQuestion {
	resolve: (answer: AskQuestionAnswer) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	options: AskQuestionOption[];
}

interface WebModelConfig {
	id?: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

interface WebProviderConfig {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	models?: WebModelConfig[];
}

interface WebModelsConfig {
	providers?: Record<string, WebProviderConfig>;
}

interface SaveProviderRequest extends WebProviderConfig {
	provider: string;
}

interface WebOAuthPromptState {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
	kind: "prompt" | "manual_code";
}

interface WebOAuthLoginState {
	id: string;
	provider: string;
	providerName: string;
	status: "starting" | "auth" | "prompt" | "complete" | "error";
	auth?: { url: string; instructions?: string };
	prompt?: WebOAuthPromptState;
	progress: string[];
	error?: string;
	resolvePrompt?: (value: string) => void;
	rejectPrompt?: (error: Error) => void;
}

export { assertHostAllowed, isLoopbackHost, parseWebArgs } from "./args.js";
export { TerminalManager, TerminalUnavailableError } from "./terminal.js";

export async function runWebMode(args: string[] = []): Promise<void> {
	const options = parseWebArgs(args);
	if (options.help) {
		console.log(usage());
		return;
	}
	assertHostAllowed(options);
	await startWebServer(options);
}

async function readModelsConfig(): Promise<WebModelsConfig> {
	try {
		const content = await fs.readFile(getModelsPath(), "utf-8");
		const parsed = JSON.parse(content) as WebModelsConfig;
		return {
			...parsed,
			providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {},
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw error;
	}
}

async function writeModelsConfig(config: WebModelsConfig): Promise<void> {
	const modelsPath = getModelsPath();
	await fs.mkdir(path.dirname(modelsPath), { recursive: true, mode: 0o700 });
	await fs.writeFile(
		modelsPath,
		`${JSON.stringify({ ...config, providers: config.providers ?? {} }, null, 2)}\n`,
		"utf-8",
	);
}

function sanitizeProviderConfig(config: WebProviderConfig): WebProviderConfig {
	const sanitized: WebProviderConfig = {};
	if (config.name?.trim()) sanitized.name = config.name.trim();
	if (config.baseUrl?.trim()) sanitized.baseUrl = config.baseUrl.trim();
	if (config.api?.trim()) sanitized.api = config.api.trim();
	if (config.authHeader !== undefined) sanitized.authHeader = !!config.authHeader;
	const models = (config.models ?? [])
		.map((model): WebModelConfig => {
			const next: WebModelConfig = {};
			if (model.id?.trim()) next.id = model.id.trim();
			if (model.name?.trim()) next.name = model.name.trim();
			if (model.api?.trim()) next.api = model.api.trim();
			if (model.baseUrl?.trim()) next.baseUrl = model.baseUrl.trim();
			if (model.reasoning !== undefined) next.reasoning = !!model.reasoning;
			if (Array.isArray(model.input)) {
				const input = model.input.filter((item) => item === "text" || item === "image");
				if (input.length > 0) next.input = input;
			}
			if (typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)) {
				next.contextWindow = Math.max(1, Math.floor(model.contextWindow));
			}
			if (typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens)) {
				next.maxTokens = Math.max(1, Math.floor(model.maxTokens));
			}
			return next;
		})
		.filter((model) => model.id);
	if (models.length > 0) sanitized.models = models;
	return sanitized;
}

async function listSettingsProviders(): Promise<Record<string, unknown>> {
	const modelsConfig = await readModelsConfig();
	const authStorage = AuthStorage.create(getAuthPath());
	const builtInProviderIds = new Set<string>(getProviders());
	const builtInProviders = [...builtInProviderIds].map((provider) => ({
		id: provider,
		name: BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ?? provider,
		builtin: true,
		auth: authStorage.getAuthStatus(provider),
	}));
	const customProviders = Object.entries(modelsConfig.providers ?? {}).map(([provider, config]) => {
		const { apiKey: _apiKey, ...safeConfig } = config;
		return {
			provider,
			...safeConfig,
			builtin: builtInProviderIds.has(provider),
			hasModelsJsonKey: !!config.apiKey,
			auth: authStorage.getAuthStatus(provider),
		};
	});
	return {
		success: true,
		data: {
			path: getModelsPath(),
			authPath: getAuthPath(),
			oauthProviders: authStorage.getOAuthProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				usesCallbackServer: provider.usesCallbackServer ?? false,
				auth: authStorage.getAuthStatus(provider.id),
			})),
			apis: [
				"openai-completions",
				"openai-responses",
				"anthropic-messages",
				"google-generative-ai",
				"mistral-conversations",
			],
			builtInProviders,
			customProviders,
		},
	};
}

async function saveSettingsProvider(input: SaveProviderRequest): Promise<Record<string, unknown>> {
	const provider = input.provider.trim();
	if (!provider) throw new HttpError(400, "Missing provider");
	const nextConfig = sanitizeProviderConfig(input);
	if (!nextConfig.baseUrl && !nextConfig.models?.length)
		throw new HttpError(400, "Provider needs a base URL or models");
	if (nextConfig.models?.length && !nextConfig.api && nextConfig.models.some((model) => !model.api)) {
		throw new HttpError(400, "Set a provider API or per-model API");
	}
	const authStorage = AuthStorage.create(getAuthPath());
	const builtInProviderIds = new Set<string>(getProviders());
	if (
		nextConfig.models?.length &&
		!builtInProviderIds.has(provider) &&
		!input.apiKey?.trim() &&
		!authStorage.hasAuth(provider)
	) {
		throw new HttpError(400, "Custom providers with models need an API key. Local providers can use a placeholder.");
	}
	const modelsConfig = await readModelsConfig();
	modelsConfig.providers = { ...(modelsConfig.providers ?? {}), [provider]: nextConfig };
	await writeModelsConfig(modelsConfig);
	if (input.apiKey?.trim()) {
		authStorage.set(provider, { type: "api_key", key: input.apiKey.trim() });
	}
	return { success: true, data: { provider } };
}

async function deleteSettingsProvider(provider: string): Promise<Record<string, unknown>> {
	const providerId = provider.trim();
	if (!providerId) throw new HttpError(400, "Missing provider");
	const modelsConfig = await readModelsConfig();
	if (modelsConfig.providers) delete modelsConfig.providers[providerId];
	await writeModelsConfig(modelsConfig);
	return { success: true, data: { provider: providerId } };
}

async function saveProviderApiKey(provider: string, apiKey: string): Promise<Record<string, unknown>> {
	const providerId = provider.trim();
	if (!providerId) throw new HttpError(400, "Missing provider");
	const authStorage = AuthStorage.create(getAuthPath());
	if (apiKey.trim()) {
		authStorage.set(providerId, { type: "api_key", key: apiKey.trim() });
	} else {
		authStorage.remove(providerId);
	}
	return { success: true, data: { provider: providerId } };
}

async function startWebServer(options: WebOptions): Promise<void> {
	const token = options.token?.trim() || "";
	const clients = new Set<http.ServerResponse>();
	const replayBuffer: WebEvent[] = [];
	const webRoot = await resolveWebRoot();
	let activeCwd = process.cwd();
	let rpcBusy = false;
	let askQuestionUrl = "";
	let progressTrackerUrl = "";
	let subagentSessionUrl = "";
	let rpc = undefined as unknown as RpcBridge;
	const oauthLogins = new Map<string, WebOAuthLoginState>();
	const terminalManager = new TerminalManager({ broadcast });
	const progressTrackerManager = new ProgressTrackerManager(broadcast);
	const gitProjectManager = new GitProjectManager(broadcast);
	const subagentSessionManager = new SubagentSessionManager(
		broadcast,
		(childBroadcast, cwd, extraEnv) => new RpcBridge(cliPath, options.rpcArgs, childBroadcast, cwd, extraEnv),
	);
	let mainSystemPromptOverride = await readMainSystemPromptOverride();
	const pendingQuestions = new Map<string, PendingQuestion>();
	let checkpointChain = Promise.resolve();

	function broadcast(event: WebEvent): void {
		if (event.type === "agent_start") rpcBusy = true;
		if (rpcBusy) {
			replayBuffer.push(event);
			if (replayBuffer.length > 500) replayBuffer.shift();
		}
		if (event.type === "agent_end") rpcBusy = false;
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of clients) res.write(payload);
		if (event.type === "agent_end") scheduleCheckpoint();
	}

	async function applyMainSystemPromptOverride(targetRpc = rpc): Promise<void> {
		if (!targetRpc) return;
		if (!mainSystemPromptOverride.trim()) return;
		try {
			await targetRpc.send({ type: "set_system_prompt", systemPrompt: mainSystemPromptOverride }, 120000);
		} catch (error) {
			broadcast({ type: "web_warning", message: error instanceof Error ? error.message : String(error) });
		}
	}

	function webEnv(): NodeJS.ProcessEnv {
		return {
			...(askQuestionUrl ? { PI_WEB_ASK_QUESTION_URL: askQuestionUrl } : {}),
			...(progressTrackerUrl ? { PI_WEB_PROGRESS_TRACKER_URL: progressTrackerUrl } : {}),
			...(subagentSessionUrl ? { PI_WEB_SUBAGENT_SESSION_URL: subagentSessionUrl } : {}),
		};
	}

	function syncProcessWebEnv(): void {
		for (const [key, value] of Object.entries(webEnv())) {
			if (value) process.env[key] = value;
		}
	}

	function serializeOAuthLogin(state: WebOAuthLoginState): Record<string, unknown> {
		return {
			id: state.id,
			provider: state.provider,
			providerName: state.providerName,
			status: state.status,
			auth: state.auth,
			prompt: state.prompt,
			progress: state.progress,
			error: state.error,
		};
	}

	function waitForOAuthPrompt(state: WebOAuthLoginState, prompt: WebOAuthPromptState): Promise<string> {
		state.status = "prompt";
		state.prompt = prompt;
		return new Promise((resolve, reject) => {
			state.resolvePrompt = (value) => {
				state.prompt = undefined;
				state.resolvePrompt = undefined;
				state.rejectPrompt = undefined;
				resolve(value);
			};
			state.rejectPrompt = (error) => {
				state.prompt = undefined;
				state.resolvePrompt = undefined;
				state.rejectPrompt = undefined;
				reject(error);
			};
		});
	}

	function startOAuthLogin(providerId: string): WebOAuthLoginState {
		const authStorage = AuthStorage.create(getAuthPath());
		const provider = authStorage.getOAuthProviders().find((candidate) => candidate.id === providerId);
		if (!provider) throw new HttpError(400, `Provider "${providerId}" does not have a built-in login flow`);

		const state: WebOAuthLoginState = {
			id: crypto.randomUUID(),
			provider: provider.id,
			providerName: provider.name,
			status: "starting",
			progress: [],
		};
		oauthLogins.set(state.id, state);

		void authStorage
			.login(provider.id, {
				onAuth: (info) => {
					state.status = "auth";
					state.auth = info;
					openBrowser(info.url);
				},
				onPrompt: (prompt) =>
					waitForOAuthPrompt(state, {
						message: prompt.message,
						placeholder: prompt.placeholder,
						allowEmpty: prompt.allowEmpty,
						kind: "prompt",
					}),
				onProgress: (message) => {
					state.progress.push(message);
					if (state.progress.length > 20) state.progress.shift();
				},
				onManualCodeInput: () =>
					waitForOAuthPrompt(state, {
						message: "Paste the redirect URL or authorization code:",
						placeholder: "http://127.0.0.1:1455/...",
						allowEmpty: false,
						kind: "manual_code",
					}),
			})
			.then(async () => {
				state.status = "complete";
				state.prompt = undefined;
				state.progress.push(`Logged in to ${provider.name}`);
				await rpc.send({ type: "reload" }, 120000);
			})
			.catch((error: unknown) => {
				state.status = "error";
				state.prompt = undefined;
				state.error = error instanceof Error ? error.message : String(error);
			});

		return state;
	}

	function openBrowser(url: string): void {
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.unref();
		} catch {
			// The UI also displays the URL for manual opening.
		}
	}

	async function syncRpcWebEnv(targetRpc = rpc): Promise<void> {
		const env = webEnv();
		if (Object.keys(env).length === 0) return;
		const response = await targetRpc.send({ type: "set_env", env }, 120000);
		if (!response.success) throw new Error(response.error);
	}

	async function restartRpc(cwd: string, startNewSession: boolean): Promise<string> {
		const resolvedCwd = path.resolve(cwd);
		const previous = rpc;
		rpc = new RpcBridge(cliPath, options.rpcArgs, broadcast, resolvedCwd, webEnv());
		activeCwd = resolvedCwd;
		previous?.stop();
		await syncRpcWebEnv();
		if (startNewSession) await rpc.send({ type: "new_session" });
		await applyMainSystemPromptOverride();
		return resolvedCwd;
	}

	const server = http.createServer((req, res) => {
		void handleRequest(req, res).catch((error) => sendError(res, error));
	});

	async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const queryTokenMatches = token && url.searchParams.get("token") === token;
		if (queryTokenMatches && !url.pathname.startsWith("/api/") && url.pathname !== "/events") {
			url.searchParams.delete("token");
			writeAuthRedirect(res, url.pathname + url.search, token);
			return;
		}

		if (token && (url.pathname.startsWith("/api/") || url.pathname === "/events") && !queryTokenMatches) {
			assertAuthorized(req, token);
			assertSafeOrigin(req);
		}

		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(`data: ${JSON.stringify({ type: "web_connected", rpcBusy })}\n\n`);
			if (rpcBusy) {
				for (const event of replayBuffer) res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
			}
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}

		if (url.pathname.startsWith("/api/")) {
			await handleApi(req, res, url);
			return;
		}

		if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
		if (url.pathname === "/favicon.svg") {
			sendText(
				res,
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6d5dfc"/><text x="32" y="43" text-anchor="middle" font-family="ui-serif, Georgia, serif" font-size="38" font-weight="700" fill="white">π</text></svg>`,
				200,
				{ "content-type": "image/svg+xml; charset=utf-8" },
			);
			return;
		}
		if (url.pathname === "/manifest.webmanifest" || url.pathname === "/service-worker.js") {
			const served = await sendStaticFile(res, webRoot, url.pathname);
			if (!served) throw new HttpError(404, "Not found");
			return;
		}
		if (url.pathname.startsWith("/web/")) {
			const served = await sendStaticFile(res, webRoot, url.pathname.slice("/web/".length));
			if (!served) throw new HttpError(404, "Not found");
			return;
		}
		if (token && !requestHasToken(req, token)) {
			sendText(res, "Unauthorized. Open the URL printed by pi web.", 401);
			return;
		}
		const served = await sendStaticFile(res, webRoot, "index.html");
		if (!served) throw new HttpError(404, "Web client not found");
	}

	async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		if (req.method === "POST" && url.pathname === "/api/prompt") {
			const body = await readJsonBody<PromptRequest>(req);
			const message = requireNonEmptyString(body.message, "message");
			const response = await handlePrompt(message, body);
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/projects") {
			const sessions = await sessionsWithActive();
			sendJson(res, { projects: groupSessionsByProject(sessions, activeCwd) });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") {
			sendJson(res, { sessions: await sessionsWithActive() });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/browse") {
			const target = path.resolve(url.searchParams.get("path") || activeCwd);
			const stat = await fs.stat(target);
			if (!stat.isDirectory()) throw new HttpError(400, `Not a directory: ${target}`);
			const entries = (await fs.readdir(target, { withFileTypes: true }))
				.filter((entry) => !entry.name.startsWith("."))
				.map((entry) => ({
					name: entry.name,
					type: entry.isDirectory() ? "directory" : "file",
					path: path.join(target, entry.name),
				}))
				.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
			const parent = path.dirname(target) !== target ? path.dirname(target) : null;
			sendJson(res, { path: target, parent, entries });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/open-project") {
			const body = await readJsonBody<{ cwd?: string }>(req);
			const cwd = await restartRpc(requireNonEmptyString(body.cwd, "cwd"), true);
			void gitProjectManager.broadcastStatus(cwd);
			sendJson(res, { success: true, cwd });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/models") {
			sendJson(res, await rpc.send({ type: "get_available_models" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/settings/providers") {
			sendJson(res, await listSettingsProviders());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings/providers") {
			const body = await readJsonBody<SaveProviderRequest>(req, 512 * 1024);
			const response = await saveSettingsProvider(body);
			await rpc.send({ type: "reload" }, 120000);
			sendJson(res, response);
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/settings/providers") {
			const body = await readJsonBody<{ provider?: string }>(req);
			const response = await deleteSettingsProvider(requireString(body.provider, "provider"));
			await rpc.send({ type: "reload" }, 120000);
			sendJson(res, response);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings/provider-key") {
			const body = await readJsonBody<{ provider?: string; apiKey?: string }>(req, 64 * 1024);
			const response = await saveProviderApiKey(
				requireString(body.provider, "provider"),
				requireString(body.apiKey, "apiKey"),
			);
			await rpc.send({ type: "reload" }, 120000);
			sendJson(res, response);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings/oauth/start") {
			const body = await readJsonBody<{ provider?: string }>(req);
			const state = startOAuthLogin(requireString(body.provider, "provider"));
			sendJson(res, { success: true, data: serializeOAuthLogin(state) });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/settings/oauth/status") {
			const id = requireString(url.searchParams.get("id"), "id");
			const state = oauthLogins.get(id);
			if (!state) throw new HttpError(404, "OAuth login not found");
			sendJson(res, { success: true, data: serializeOAuthLogin(state) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings/oauth/answer") {
			const body = await readJsonBody<{ id?: string; value?: string }>(req, 64 * 1024);
			const state = oauthLogins.get(requireString(body.id, "id"));
			if (!state) throw new HttpError(404, "OAuth login not found");
			if (!state.resolvePrompt) throw new HttpError(400, "OAuth login is not waiting for input");
			state.resolvePrompt(requireString(body.value, "value"));
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/settings/oauth/cancel") {
			const body = await readJsonBody<{ id?: string }>(req);
			const id = requireString(body.id, "id");
			const state = oauthLogins.get(id);
			if (state?.rejectPrompt) state.rejectPrompt(new Error("Login cancelled"));
			oauthLogins.delete(id);
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/model") {
			const body = await readJsonBody<SetModelRequest>(req);
			const response = await rpc.send({
				type: "set_model",
				provider: requireString(body.provider, "provider"),
				modelId: requireString(body.modelId, "modelId"),
			});
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/thinking") {
			const body = await readJsonBody<SetThinkingRequest>(req);
			const response = await rpc.send({ type: "set_thinking_level", level: body.level });
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/commands") {
			sendJson(res, await mergeCommands(await rpc.send({ type: "get_commands" })));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/skills") {
			sendJson(res, { skills: await listWebSkills() });
			return;
		}
		if ((req.method === "POST" || req.method === "PUT") && url.pathname === "/api/skills") {
			const body = await readJsonBody<SkillWriteRequest>(req);
			sendJson(res, { success: true, skill: await writeWebSkill(body, req.method) });
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/skills") {
			const body = await readJsonBody<{ path?: string }>(req);
			await deleteWebSkill(body.path);
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask-question") {
			const body = await readJsonBody<AskQuestionRequest>(req, 64 * 1024);
			sendJson(res, await askQuestion(body));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask-question/answer") {
			const body = await readJsonBody<AskQuestionAnswer & { id?: string }>(req, 64 * 1024);
			answerQuestion(body.id, body);
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/preview-tab") {
			const body = await readJsonBody<PreviewTabRequest>(req, 64 * 1024);
			const data = previewTab(body);
			broadcast({ type: "preview_tab", data });
			sendJson(res, { success: true, data });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/agents/registry") {
			const body = await readJsonBody<AgentRegistrySyncRequest>(req, 1024 * 1024);
			subagentSessionManager.setAgents(Array.isArray(body.agents) ? body.agents : []);
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/subagent-session") {
			const body = await readJsonBody<SubagentSessionRequest>(req, 1024 * 1024);
			const data = await subagentSessionManager.run(body, activeCwd, webEnv());
			sendJson(res, { success: true, data }, 200);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/progress-tracker") {
			sendJson(res, { success: true, data: await progressTrackerManager.state(await currentSessionFile()) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/progress-tracker") {
			const body = await readJsonBody<ProgressTrackerRequest>(req, 64 * 1024);
			const data = await progressTrackerManager.register(
				requireNonEmptyString(body.path, "path"),
				activeCwd,
				await requireCurrentSessionFile(),
			);
			sendJson(res, { success: true, data });
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/progress-tracker") {
			progressTrackerManager.remove(await requireCurrentSessionFile());
			sendJson(res, { success: true });
			return;
		}
		if (url.pathname.startsWith("/api/git/")) {
			await handleGitApi(req, res, url);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/messages") {
			sendJson(res, await rpc.send({ type: "get_messages" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/local-image") {
			await sendLocalImage(res, requireNonEmptyString(url.searchParams.get("path"), "path"));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/preview-file") {
			await sendPreviewFile(res, requireNonEmptyString(url.searchParams.get("path"), "path"));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/new-session") {
			const response = await startNewSession();
			const state = await currentRpcState();
			sendJson(
				res,
				{
					...response,
					data: {
						...(response.success && "data" in response ? response.data : {}),
						session: state?.sessionFile
							? {
									path: state.sessionFile,
									id: state.sessionId,
									cwd: activeCwd,
									name: state.sessionName || "New Session",
									firstMessage: "(no messages)",
									modified: new Date().toISOString(),
									created: new Date().toISOString(),
									messageCount: state.messageCount,
								}
							: undefined,
					},
				},
				response.success ? 200 : 400,
			);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/switch-session") {
			const body = await readJsonBody<SwitchSessionRequest>(req);
			const sessionPath = requireNonEmptyString(body.sessionPath, "sessionPath");
			const response = await rpc.send({ type: "switch_session", sessionPath });
			if (response.success) {
				const sessions = await SessionManager.listAll();
				const match = sessions.find((session) => path.resolve(session.path) === path.resolve(sessionPath));
				if (match?.cwd) activeCwd = match.cwd;
				void applyMainSystemPromptOverride();
				void gitProjectManager.broadcastStatus(activeCwd);
			}
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/session") {
			const body = await readJsonBody<SwitchSessionRequest>(req);
			const sessionPath = requireNonEmptyString(body.sessionPath, "sessionPath");
			const sessions = await SessionManager.listAll();
			const match = sessions.find((session) => path.resolve(session.path) === path.resolve(sessionPath));
			if (!match) throw new HttpError(400, "Unknown session");
			await fs.rm(sessionPath, { force: true });
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			sendJson(res, await rpc.send({ type: "get_state" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/stats") {
			const response = await rpc.send<WebRpcResponse & { data?: Record<string, unknown> }>({
				type: "get_session_stats",
			});
			const messagesResponse = await rpc.send<WebRpcResponse & { data?: { messages?: unknown[] } }>({
				type: "get_messages",
			});
			const stateResponse = await rpc.send<WebRpcResponse & { data?: { model?: { contextWindow?: number } } }>({
				type: "get_state",
			});
			if (response.success && messagesResponse.success) {
				const messages = (messagesResponse.data?.messages ?? []) as Parameters<typeof estimateContextTokens>[0];
				const estimated = estimateContextTokens(messages);
				const contextWindow = stateResponse.data?.model?.contextWindow ?? null;
				response.data = {
					...(response.data ?? {}),
					estimatedContextUsage: {
						tokens: estimated.tokens,
						contextWindow,
						percent: contextWindow ? (estimated.tokens / contextWindow) * 100 : null,
					},
				};
			}
			sendJson(res, response);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/system-prompt") {
			sendJson(res, await rpc.send({ type: "get_system_prompt" }));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/system-prompt") {
			const body = await readJsonBody<SystemPromptRequest>(req);
			mainSystemPromptOverride = requireNonEmptyString(body.systemPrompt, "systemPrompt");
			await writeMainSystemPromptOverride(mainSystemPromptOverride);
			const response = await rpc.send({ type: "set_system_prompt", systemPrompt: mainSystemPromptOverride }, 120000);
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/agent/apply") {
			const body = await readJsonBody<ApplyAgentRequest>(req, 1024 * 1024);
			const systemPrompt = requireNonEmptyString(body.systemPrompt, "systemPrompt");
			const tools = Array.isArray(body.tools)
				? body.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
				: [];
			await syncRpcWebEnv();
			const toolsResponse = await rpc.send({ type: "set_active_tools", tools }, 120000);
			if (!toolsResponse.success) {
				sendJson(res, toolsResponse, 400);
				return;
			}
			const appliedTools = toolsResponse.command === "set_active_tools" ? toolsResponse.data.tools : tools;
			const promptResponse = await rpc.send({ type: "set_system_prompt", systemPrompt }, 120000);
			sendJson(
				res,
				{ success: promptResponse.success, data: { tools: appliedTools, systemPrompt } },
				promptResponse.success ? 200 : 400,
			);
			return;
		}
		if (url.pathname.startsWith("/api/terminal/")) {
			await handleTerminalApi(req, res, url);
			return;
		}
		throw new HttpError(404, "Not found");
	}

	async function sendLocalImage(res: http.ServerResponse, filePath: string): Promise<void> {
		const expandedPath =
			filePath === "~" || filePath.startsWith(`~${path.sep}`) ? path.join(homedir(), filePath.slice(2)) : filePath;
		const resolvedPath = path.resolve(expandedPath);
		const mimeType = await detectSupportedImageMimeTypeFromFile(resolvedPath);
		if (!mimeType) throw new HttpError(404, "Image not found");
		const data = await fs.readFile(resolvedPath);
		res.writeHead(200, { "content-type": mimeType, "cache-control": "no-cache" });
		res.end(data);
	}

	function previewTab(input: PreviewTabRequest): PreviewTabData {
		const source = String(input.source || "").trim();
		const resolved = resolvePreviewSource(source || "/");
		return {
			id: `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
			source,
			url: resolved.url,
			title: String(input.title || "").trim() || resolved.title,
			kind: resolved.kind,
		};
	}

	function resolvePreviewSource(source: string): { url: string; title: string; kind: "url" | "file" } {
		if (/^https?:\/\//i.test(source)) return { url: source, title: source, kind: "url" };
		const host = source.split(/[/?#]/)[0] || "";
		if (
			!source.startsWith(".") &&
			!source.startsWith("/") &&
			(/^(localhost|127(?:\.\d{1,3}){3})(?::\d+)?$/i.test(host) ||
				/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i.test(host))
		) {
			return { url: `http://${source}`, title: source, kind: "url" };
		}
		const expandedPath = source === "~" || source.startsWith("~/") ? path.join(homedir(), source.slice(2)) : source;
		const filePath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(activeCwd, expandedPath);
		return {
			url: `/api/preview-file?path=${encodeURIComponent(filePath)}`,
			title: path.basename(filePath) || filePath,
			kind: "file",
		};
	}

	async function sendPreviewFile(res: http.ServerResponse, filePath: string): Promise<void> {
		const expandedPath =
			filePath === "~" || filePath.startsWith(`~${path.sep}`) ? path.join(homedir(), filePath.slice(2)) : filePath;
		const resolvedPath = path.resolve(expandedPath);
		const stat = await fs.stat(resolvedPath).catch(() => null);
		if (!stat?.isFile()) throw new HttpError(404, "Preview file not found");
		const data = await fs.readFile(resolvedPath);
		res.writeHead(200, { "content-type": contentTypeFor(resolvedPath), "cache-control": "no-cache" });
		res.end(data);
	}

	async function handleTerminalApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		try {
			if (req.method === "GET" && url.pathname === "/api/terminal/state") {
				sendJson(res, { success: true, data: terminalManager.state(activeCwd) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/start") {
				sendJson(res, { success: true, data: terminalManager.start(activeCwd) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/restart") {
				terminalManager.stop(activeCwd);
				sendJson(res, { success: true, data: terminalManager.start(activeCwd) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/input") {
				const body = await readJsonBody<TerminalInputRequest>(req);
				sendJson(res, {
					success: true,
					data: terminalManager.write(activeCwd, requireString(body.data, "terminal input")),
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/resize") {
				const body = await readJsonBody<TerminalResizeRequest>(req);
				sendJson(res, { success: true, data: terminalManager.resize(activeCwd, body.cols, body.rows) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/stop") {
				sendJson(res, { success: true, data: terminalManager.stop(activeCwd) });
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			if (error instanceof TerminalUnavailableError) {
				sendText(res, error.message, 503);
				return;
			}
			throw error;
		}
	}

	async function handleGitApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		if (req.method === "GET" && url.pathname === "/api/git/status") {
			sendJson(res, { success: true, data: await gitProjectManager.status(activeCwd) });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/git/branches") {
			sendJson(res, { success: true, data: await gitProjectManager.branches(activeCwd) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/git/commit") {
			const body = await readJsonBody<GitCommitRequest>(req, 64 * 1024);
			sendJson(res, { success: true, data: await gitProjectManager.commit(activeCwd, body.message) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/git/switch-branch") {
			const body = await readJsonBody<GitBranchSwitchRequest>(req, 64 * 1024);
			sendJson(res, { success: true, data: await gitProjectManager.switchBranch(activeCwd, body.branch) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/git/push") {
			sendJson(res, { success: true, data: await gitProjectManager.push(activeCwd) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/git/init") {
			sendJson(res, { success: true, data: await gitProjectManager.init(activeCwd) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/git/create-github-repo") {
			sendJson(res, { success: true, data: await gitProjectManager.createGithubRepo(activeCwd) });
			return;
		}
		throw new HttpError(404, "Not found");
	}

	function askQuestion(input: AskQuestionRequest): Promise<AskQuestionAnswer> {
		const question = requireNonEmptyString(input.question, "question");
		if (!Array.isArray(input.options)) throw new HttpError(400, "Missing options");
		const options = input.options.map(normalizeQuestionOption).filter((option) => option.label);
		if (options.length === 0) throw new HttpError(400, "Missing options");
		if (options.length > 12) throw new HttpError(400, "Too many options");
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => {
					pendingQuestions.delete(id);
					reject(new HttpError(408, "Question timed out"));
				},
				10 * 60 * 1000,
			);
			pendingQuestions.set(id, { resolve, reject, timeout, options });
			broadcast({ type: "ask_question", id, question, options });
		});
	}

	function answerQuestion(id: string | undefined, answer: AskQuestionAnswer): void {
		if (!id) throw new HttpError(400, "Missing question id");
		const pending = pendingQuestions.get(id);
		if (!pending) throw new HttpError(404, "Question not found");
		const response = normalizeQuestionAnswer(answer, pending.options);
		clearTimeout(pending.timeout);
		pendingQuestions.delete(id);
		pending.resolve(response);
	}

	function contentToText(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const record = part as Record<string, unknown>;
				return typeof record.text === "string"
					? record.text
					: typeof record.content === "string"
						? record.content
						: typeof record.thinking === "string"
							? record.thinking
							: "";
			})
			.filter(Boolean)
			.join("\n");
	}

	function firstUserMessage(messages: unknown[]): string {
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			const record = message as Record<string, unknown>;
			if (record.role !== "user") continue;
			const text = contentToText(record.content).trim();
			if (text) return text;
		}
		return "(no messages)";
	}

	async function sessionsWithActive(): Promise<SessionInfo[]> {
		const sessions = await SessionManager.listAll();
		const stateResponse = await rpc
			.send<WebRpcResponse & { data?: WebRpcState }>({ type: "get_state" })
			.catch(() => null);
		if (!stateResponse?.success || !stateResponse.data?.sessionFile) return sessions;

		const sessionPath = path.resolve(stateResponse.data.sessionFile);
		if (sessions.some((session) => path.resolve(session.path) === sessionPath)) return sessions;
		const activeFileExists = await fs
			.stat(sessionPath)
			.then((stat) => stat.isFile())
			.catch(() => false);
		if (!activeFileExists) return sessions;

		const messagesResponse = await rpc
			.send<WebRpcResponse & { data?: { messages?: unknown[] } }>({ type: "get_messages" })
			.catch(() => null);
		const messages = messagesResponse?.success ? (messagesResponse.data?.messages ?? []) : [];
		const now = new Date();
		return [
			{
				path: sessionPath,
				id: stateResponse.data.sessionId,
				cwd: activeCwd,
				name: stateResponse.data.sessionName,
				created: now,
				modified: now,
				messageCount: stateResponse.data.messageCount,
				firstMessage: firstUserMessage(messages),
				allMessagesText: messages
					.map((message) => contentToText((message as Record<string, unknown>)?.content))
					.join(" "),
			},
			...sessions,
		];
	}

	async function currentRpcState(): Promise<WebRpcState | null> {
		const response = await rpc.send<WebRpcResponse & { data?: WebRpcState }>({ type: "get_state" }).catch(() => null);
		return response?.success ? (response.data ?? null) : null;
	}

	async function startNewSession(): Promise<WebRpcResponse> {
		const response = await rpc.send<WebRpcResponse & { data?: { cancelled?: boolean } }>({ type: "new_session" });
		if (response.success && response.command === "new_session" && !response.data?.cancelled) {
			await rpc.send({ type: "set_session_name", name: "New Session" });
			await applyMainSystemPromptOverride();
		}
		return response;
	}

	async function currentSessionFile(): Promise<string | null> {
		const response = await rpc.send<WebRpcResponse & { data?: { sessionFile?: string } }>({ type: "get_state" });
		return response.success ? response.data?.sessionFile || null : null;
	}

	async function requireCurrentSessionFile(): Promise<string> {
		const sessionFile = await currentSessionFile();
		if (!sessionFile) throw new HttpError(400, "No active conversation session file");
		return sessionFile;
	}

	function scheduleCheckpoint(): void {
		checkpointChain = checkpointChain
			.then(async () => {
				const sessionFile = await currentSessionFile().catch(() => null);
				await gitProjectManager.checkpoint(activeCwd, sessionFile);
			})
			.catch((error) => {
				broadcast({ type: "web_warning", message: error instanceof Error ? error.message : String(error) });
			});
	}

	async function handlePrompt(message: string, body: PromptRequest): Promise<WebRpcResponse> {
		if (!message.trim().startsWith("/")) {
			return rpc.send({
				type: "prompt",
				message,
				images: body.images,
				streamingBehavior: body.streamingBehavior,
			});
		}
		const [rawCommand, ...rest] = message.trim().slice(1).split(/\s+/);
		const commandName = rawCommand.toLowerCase();
		const commandArgs = rest.join(" ").trim();
		switch (commandName) {
			case "compact":
				return rpc.send(
					commandArgs ? { type: "compact", customInstructions: commandArgs } : { type: "compact" },
					120000,
				);
			case "new": {
				return startNewSession();
			}
			case "export":
				return rpc.send(
					commandArgs ? { type: "export_html", outputPath: commandArgs } : { type: "export_html" },
					120000,
				);
			case "session":
				return rpc.send({ type: "get_session_stats" });
			case "copy":
				return rpc.send({ type: "get_last_assistant_text" });
			case "abort":
				return rpc.send({ type: "abort" });
			case "commands":
				return mergeCommands(await rpc.send({ type: "get_commands" }));
			case "name":
				if (!commandArgs) throw new HttpError(400, "Usage: /name <session name>");
				return rpc.send({ type: "set_session_name", name: commandArgs });
			case "clone":
				return rpc.send({ type: "clone" });
			case "reload": {
				await restartRpc(activeCwd, false);
				return textResponse("reload", "Reloaded Pi web RPC process.");
			}
			case "model":
				if (!commandArgs) return rpc.send({ type: "get_state" });
				return setModelByNeedle(commandArgs);
			case "settings":
				return rpc.send({ type: "get_state" });
			case "scoped-models":
				return rpc.send({ type: "get_available_models" });
			case "hotkeys":
				return textResponse(
					"hotkeys",
					"Web hotkeys: Enter send, Shift+Enter newline, / for commands, Tab/Enter apply slash command, mobile swipe opens sidebar.",
				);
			case "changelog":
				return textResponse("changelog", await readChangelog());
			case "resume":
				return resumeResponse();
			case "tree":
				return textResponse(
					"tree",
					"Tree navigation is not available in the web UI yet. Use the conversation list/sidebar or the TUI /tree command.",
				);
			case "fork":
				return textResponse(
					"fork",
					"Fork selection is not available in the web UI yet. Use the TUI /fork command.",
				);
			default:
				if (commandName.startsWith("skill:")) {
					const skillName = commandName.slice("skill:".length);
					return rpc.sendDetached({
						type: "prompt",
						message: `Use the ${skillName} skill. ${commandArgs}`.trim(),
					});
				}
				if (["import", "share", "login", "logout", "quit"].includes(commandName)) {
					throw new HttpError(400, `/${commandName} is interactive-only and is not available in Pi web yet`);
				}
				return rpc.sendDetached({
					type: "prompt",
					message: `${message}\n\nExecute the slash command above as requested.`,
				});
		}
	}

	async function setModelByNeedle(needleInput: string): Promise<WebRpcResponse> {
		const modelsResponse = await rpc.send<
			WebRpcResponse & { data?: { models?: Array<{ provider: string; id: string; name?: string }> } }
		>({
			type: "get_available_models",
		});
		const needle = needleInput.toLowerCase();
		const model = (modelsResponse.data?.models ?? []).find(
			(m) =>
				`${m.provider}/${m.id}`.toLowerCase() === needle ||
				m.id.toLowerCase() === needle ||
				(m.name || "").toLowerCase() === needle ||
				`${m.provider}/${m.id}`.toLowerCase().includes(needle),
		);
		if (!model) throw new HttpError(400, `Model not found: ${needleInput}`);
		return rpc.send({ type: "set_model", provider: model.provider, modelId: model.id });
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	askQuestionUrl = askQuestionEndpointUrl(options.host, port, token);
	progressTrackerUrl = progressTrackerEndpointUrl(options.host, port, token);
	subagentSessionUrl = subagentSessionEndpointUrl(options.host, port, token);
	syncProcessWebEnv();
	await restartRpc(activeCwd, false);
	void gitProjectManager.broadcastStatus(activeCwd);
	const urls = webUrls(options.host, port, token);
	console.log(`Pi web UI running at ${urls.local}`);
	for (const url of urls.network) console.log(`Network URL: ${url}`);
	console.log(`Headless Pi RPC PID: ${rpc.pid}`);
	if (options.open) openBrowser(urls.local);

	const shutdown = (): void => {
		server.close();
		terminalManager.stopAll();
		progressTrackerManager.stopAll();
		subagentSessionManager.stopAll();
		rpc.stop();
		for (const [id, pending] of pendingQuestions) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Pi web server stopped"));
			pendingQuestions.delete(id);
		}
	};
	process.once("SIGINT", () => {
		shutdown();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		shutdown();
		process.exit(143);
	});
}

async function resolveWebRoot(): Promise<string> {
	try {
		await fs.access(path.join(sourceWebDir, "index.html"));
		return sourceWebDir;
	} catch {
		return distWebDir;
	}
}

async function readMainSystemPromptOverride(): Promise<string> {
	try {
		return await fs.readFile(webMainSystemPromptPath, "utf8");
	} catch {
		return "";
	}
}

async function writeMainSystemPromptOverride(value: string): Promise<void> {
	await fs.mkdir(path.dirname(webMainSystemPromptPath), { recursive: true });
	await fs.writeFile(webMainSystemPromptPath, value, "utf8");
}

async function mergeCommands(response: WebRpcResponse): Promise<WebRpcResponse> {
	const dynamicCommands = response.success && response.command === "get_commands" ? response.data.commands : [];
	const skills = await listWebSkills();
	const skillNames = new Set(skills.map((skill) => skill.name));
	const byName = new Map<string, WebCommand>();
	for (const command of BUILTIN_SLASH_COMMANDS) byName.set(command.name, { ...command, source: "builtin" });
	for (const command of dynamicCommands) {
		if (command.name.startsWith("skill:") && !skillNames.has(command.name.slice("skill:".length))) continue;
		byName.set(command.name, command);
	}
	for (const skill of skills) {
		byName.set(`skill:${skill.name}`, {
			name: `skill:${skill.name}`,
			description: skill.description || `Use skill ${skill.name}`,
			source: "skill",
		});
	}
	return {
		type: "response",
		command: "get_commands",
		success: true,
		data: { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) },
	} as WebRpcResponse;
}

function textResponse(command: string, text: string): WebRpcResponse {
	return { type: "response", command, success: true, data: { text } } as WebRpcResponse;
}

function normalizeQuestionOption(option: string | AskQuestionOption): AskQuestionOption {
	if (typeof option === "string") return { label: option.trim() };
	const label = String(option?.label || "").trim();
	const image = String(option?.image || "").trim();
	const description = String(option?.description || "").trim();
	return {
		label,
		...(image ? { image } : {}),
		...(description ? { description } : {}),
	};
}

function normalizeQuestionAnswer(answer: AskQuestionAnswer, options: AskQuestionOption[]): AskQuestionAnswer {
	if (answer.custom) {
		const customAnswer = String(answer.answer || "").trim();
		if (!customAnswer) throw new HttpError(400, "Missing custom answer");
		return { answer: customAnswer, optionIndex: null, custom: true };
	}
	const optionIndex = Number(answer.optionIndex);
	if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
		throw new HttpError(400, "Invalid optionIndex");
	}
	return { answer: options[optionIndex]?.label || "", optionIndex, custom: false };
}

function askQuestionEndpointUrl(host: string, port: number, token: string): string {
	return webApiEndpointUrl(host, port, token, "/api/ask-question");
}

function progressTrackerEndpointUrl(host: string, port: number, token: string): string {
	return webApiEndpointUrl(host, port, token, "/api/progress-tracker");
}

function subagentSessionEndpointUrl(host: string, port: number, token: string): string {
	return webApiEndpointUrl(host, port, token, "/api/subagent-session");
}

function webApiEndpointUrl(host: string, port: number, token: string, pathname: string): string {
	const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
	const localHost = wildcard ? "127.0.0.1" : host;
	const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
	return `http://${localHost}:${port}${pathname}${tokenQuery}`;
}

async function readChangelog(): Promise<string> {
	const changelog = await fs
		.readFile(path.resolve(__dirname, "..", "..", "..", "CHANGELOG.md"), "utf8")
		.catch(() => "Changelog not found.");
	return changelog.split(/\r?\n/).slice(0, 120).join("\n");
}

async function resumeResponse(): Promise<WebRpcResponse> {
	const sessions = await SessionManager.listAll();
	return {
		type: "response",
		command: "resume",
		success: true,
		data: {
			sessions: sessions.slice(0, 50).map((session) => ({
				id: session.id,
				path: session.path,
				cwd: session.cwd,
				name: session.name,
				modified: session.modified,
			})),
		},
	} as WebRpcResponse;
}

function webUrls(host: string, port: number, token: string): { local: string; network: string[] } {
	const suffix = token ? `/?token=${encodeURIComponent(token)}` : "/";
	const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
	const localHost = wildcard ? "localhost" : host;
	const network = wildcard
		? Object.values(networkInterfaces())
				.flatMap((items) => items ?? [])
				.filter((item) => item.family === "IPv4" && !item.internal)
				.map((item) => `http://${item.address}:${port}${suffix}`)
		: [];
	return { local: `http://${localHost}:${port}${suffix}`, network };
}
