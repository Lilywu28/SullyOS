/**
 * 通用 MCP 客户端 (Model Context Protocol, Streamable HTTP)
 *
 * 与 mcdMcpClient / luckinMcpClient 的「一家一个客户端」不同，这里是用户
 * 自配的任意远程 MCP 服务器：设置里填 URL（+ 可选 Bearer Token），发现工具后
 * 以 OpenAI function-calling 格式注入聊天请求，工具循环见 useChatAI。
 *
 * 网络路径（用户三选一，见 docs/mcp-client.md）：
 * 1. 直连 —— MCP 服务器 CORS 配置正确时（能读到 Mcp-Session-Id 响应头）
 * 2. 本地代理 —— node scripts/mcp-proxy.mjs，代理 URL 填 http://localhost:18061
 * 3. 用户自己的 Cloudflare Worker —— worker/mcp-proxy/，部署到用户自己的账号
 * 代理约定统一为 <代理URL>?target=<url-encoded 服务器URL>，可选 X-Proxy-Key 头。
 * 刻意不走中心 sfworker：MCP 流量（含用户的 Bearer Token）不该过项目方的服务器。
 */

export interface McpToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface McpServerConfig {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可选（Authorization: Bearer <token>） */
    token?: string;
    /** 代理 URL，可选。空 = 浏览器直连 */
    proxyUrl?: string;
    /** 自部署 Worker 的防白嫖密钥，可选（X-Proxy-Key 头） */
    proxyKey?: string;
    enabled: boolean;
    /** 「发现工具」后持久化的工具清单（聊天注入直接读这里，不用每次握手） */
    tools?: McpToolDef[];
    updatedAt: number;
}

export interface McpToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';
const MCP_PROTOCOL_VERSION = '2024-11-05';

// ========== 服务器配置 (持久化在 localStorage) ==========

export const loadMcpServers = (): McpServerConfig[] => {
    try {
        const raw = localStorage.getItem(MCP_SERVERS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
};

export const saveMcpServers = (servers: McpServerConfig[]): void => {
    try { localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers)); } catch { /* ignore */ }
};

export const createMcpServer = (name: string, url: string): McpServerConfig => ({
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    url,
    enabled: false,
    updatedAt: Date.now(),
});

export const getEnabledMcpServers = (): McpServerConfig[] =>
    loadMcpServers().filter(s => s.enabled && s.url && (s.tools?.length || 0) > 0);

/** 有任何一个启用且已发现工具的服务器 → 聊天进入 MCP 工具模式 */
export const isMcpChatAvailable = (): boolean => getEnabledMcpServers().length > 0;

// ── 备份用：随「设置 → 导出/导入备份」一起带走（存 localStorage） ──
export function exportMcpLocal(): Record<string, string> | undefined {
    try {
        const raw = localStorage.getItem(MCP_SERVERS_KEY);
        return raw ? { [MCP_SERVERS_KEY]: raw } : undefined;
    } catch { return undefined; }
}
export function importMcpLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[MCP_SERVERS_KEY] === 'string') localStorage.setItem(MCP_SERVERS_KEY, data[MCP_SERVERS_KEY]);
    } catch { /* ignore */ }
}

// ========== JSON-RPC 会话状态 (内存, 每服务器一份) ==========

interface McpJsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id?: number;
}

interface McpJsonRpcResponse {
    jsonrpc: '2.0';
    id?: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface McpSession {
    sessionId: string | null;
    initialized: boolean;
    initPromise: Promise<void> | null;
}

const sessions = new Map<string, McpSession>();
let requestIdCounter = 0;

const getSession = (serverId: string): McpSession => {
    let s = sessions.get(serverId);
    if (!s) {
        s = { sessionId: null, initialized: false, initPromise: null };
        sessions.set(serverId, s);
    }
    return s;
};

export const resetMcpSession = (serverId: string): void => {
    sessions.delete(serverId);
};

/** 实际请求地址：配了代理就包成 <proxy>?target=<url>，没配就直连 */
export const buildMcpFetchUrl = (server: Pick<McpServerConfig, 'url' | 'proxyUrl'>): string => {
    const proxy = (server.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!proxy) return server.url;
    const sep = proxy.includes('?') ? '&' : '?';
    return `${proxy}${sep}target=${encodeURIComponent(server.url)}`;
};

const buildRequest = (method: string, params?: any, isNotification = false): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++requestIdCounter;
    return req;
};

const parseSse = (text: string): McpJsonRpcResponse | null => {
    const dataLines: string[] = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
    }
    for (let i = dataLines.length - 1; i >= 0; i--) {
        try { return JSON.parse(dataLines[i]); } catch { /* try previous */ }
    }
    return null;
};

const parseResp = (text: string, contentType: string): McpJsonRpcResponse => {
    if (contentType.includes('text/event-stream') || /^\s*(event:|data:)/.test(text)) {
        const parsed = parseSse(text);
        if (parsed) return parsed;
    }
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(`MCP: 无法解析响应: ${text.slice(0, 300)}`);
    }
};

const post = async (
    server: McpServerConfig,
    body: McpJsonRpcRequest,
    expectResponse = true,
): Promise<{ response: McpJsonRpcResponse | null }> => {
    const session = getSession(server.id);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (server.token) headers['Authorization'] = `Bearer ${server.token}`;
    if (server.proxyUrl && server.proxyKey) headers['X-Proxy-Key'] = server.proxyKey;
    if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;

    let resp: Response;
    try {
        resp = await fetch(buildMcpFetchUrl(server), { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e: any) {
        // 直连时 fetch 抛 TypeError 十有八九是 CORS，把排查方向直接告诉用户
        const hint = server.proxyUrl
            ? '请检查代理 URL 是否可访问、代理密钥是否正确。'
            : '很可能是浏览器 CORS 限制。请在这个服务器的「代理 URL」里配置代理（本地 node scripts/mcp-proxy.mjs 或自部署 worker/mcp-proxy）。';
        throw new Error(`MCP 请求失败: ${e?.message || e}。${hint}`);
    }
    const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
    if (newSid) session.sessionId = newSid;

    if (resp.status === 401 || resp.status === 403) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP 鉴权失败 (${resp.status}): Token 可能无效或过期。${txt.slice(0, 120)}`);
    }
    if (resp.status === 202) return { response: null };
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    if (!expectResponse) return { response: null };

    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    return { response: parseResp(text, ct) };
};

const doInitialize = async (server: McpServerConfig): Promise<void> => {
    const session = getSession(server.id);
    const initReq = buildRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'SullyOS-MCP', version: '1.0.0' },
    });
    const { response } = await post(server, initReq);
    if (response?.error) throw new Error(`Initialize 失败: ${response.error.message}`);

    // 直连模式下读不到 Session-Id 说明 CORS 没暴露响应头（服务器可能有会话但我们拿不到），
    // Streamable HTTP 无状态服务器也可能压根不发。这里不硬报错：tools/list 能通就算能用。
    const notif = buildRequest('notifications/initialized', {}, true);
    await post(server, notif, false).catch(() => { /* notification 失败不阻塞 */ });

    session.initialized = true;
};

const ensureInitialized = async (server: McpServerConfig): Promise<void> => {
    const session = getSession(server.id);
    if (session.initialized) return;
    if (!session.initPromise) {
        session.initPromise = doInitialize(server).catch((e) => {
            session.initPromise = null;
            throw e;
        });
    }
    await session.initPromise;
};

// ========== 公开 API ==========

/** 握手 + tools/list。调用方负责把返回的工具清单存回 McpServerConfig.tools */
export const discoverMcpTools = async (server: McpServerConfig): Promise<McpToolDef[]> => {
    resetMcpSession(server.id);
    await ensureInitialized(server);
    const { response } = await post(server, buildRequest('tools/list'));
    if (response?.error) throw new Error(`tools/list 失败: ${response.error.message}`);
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
    }));
};

/** 调用一个工具（会自动补握手；session 失效自动重试一次） */
export const callMcpTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any> = {},
): Promise<McpToolResult> => {
    try {
        await ensureInitialized(server);
        const body = buildRequest('tools/call', { name: toolName, arguments: args });
        let response: McpJsonRpcResponse | null;
        try {
            ({ response } = await post(server, body));
        } catch (e: any) {
            // 404/400 常见于服务器重启后 session 失效，重握手再试一次
            if (/HTTP (400|404)/.test(e?.message || '')) {
                resetMcpSession(server.id);
                await ensureInitialized(server);
                ({ response } = await post(server, buildRequest('tools/call', { name: toolName, arguments: args })));
            } else {
                throw e;
            }
        }
        if (!response) return { success: false, error: '空响应' };
        if (response.error) return { success: false, error: `MCP 错误 [${response.error.code}]: ${response.error.message}` };

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return { success: false, error: fullText || 'MCP 工具执行失败', rawText: fullText };
            try {
                return { success: true, data: JSON.parse(fullText), rawText: fullText };
            } catch {
                return { success: true, data: fullText, rawText: fullText };
            }
        }
        return { success: true, data: result };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
};

/** 测试连接: 验证握手 + tools/list 能通，返回工具清单供持久化 */
export const testMcpConnection = async (server: McpServerConfig): Promise<{ ok: boolean; message: string; tools?: McpToolDef[] }> => {
    try {
        const tools = await discoverMcpTools(server);
        if (!tools.length) return { ok: true, message: '已连接, 但工具清单为空', tools };
        return { ok: true, message: `已连接, 发现 ${tools.length} 个工具: ${tools.map(t => t.name).slice(0, 8).join('、')}${tools.length > 8 ? '…' : ''}`, tools };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};
