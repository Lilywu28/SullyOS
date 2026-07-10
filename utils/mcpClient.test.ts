import { describe, it, expect, beforeEach } from 'vitest';
import {
    buildMcpFetchUrl,
    createMcpServer,
    loadMcpServers,
    saveMcpServers,
    exportMcpLocal,
    importMcpLocal,
    isMcpChatAvailable,
    type McpServerConfig,
} from './mcpClient';
import { buildMcpOpenAITools } from './mcpToolBridge';

const mkServer = (over: Partial<McpServerConfig>): McpServerConfig => ({
    ...createMcpServer('测试', 'https://mcp.example.com/mcp'),
    enabled: true,
    tools: [{ name: 'search', description: '搜点东西', inputSchema: { type: 'object', properties: {} } }],
    ...over,
});

beforeEach(() => {
    localStorage.removeItem('aetheros.mcp.servers');
});

describe('buildMcpFetchUrl', () => {
    it('没配代理就直连服务器 URL', () => {
        expect(buildMcpFetchUrl({ url: 'https://mcp.example.com/mcp' })).toBe('https://mcp.example.com/mcp');
    });

    it('配了代理包成 ?target=<url-encoded>（与 worker/mcp-proxy 和 scripts/mcp-proxy.mjs 的约定一致）', () => {
        expect(buildMcpFetchUrl({ url: 'https://mcp.example.com/mcp', proxyUrl: 'http://localhost:18061' }))
            .toBe('http://localhost:18061?target=https%3A%2F%2Fmcp.example.com%2Fmcp');
    });

    it('代理尾部斜杠被剥掉，已带 query 的代理用 & 续接', () => {
        expect(buildMcpFetchUrl({ url: 'https://a.com/mcp', proxyUrl: 'https://w.dev/' }))
            .toBe('https://w.dev?target=https%3A%2F%2Fa.com%2Fmcp');
        expect(buildMcpFetchUrl({ url: 'https://a.com/mcp', proxyUrl: 'https://w.dev?x=1' }))
            .toBe('https://w.dev?x=1&target=https%3A%2F%2Fa.com%2Fmcp');
    });
});

describe('服务器配置持久化', () => {
    it('save → load 往返一致，坏 JSON 回退空数组', () => {
        const s = mkServer({ name: 'Notion' });
        saveMcpServers([s]);
        expect(loadMcpServers()).toEqual([s]);
        localStorage.setItem('aetheros.mcp.servers', '{broken');
        expect(loadMcpServers()).toEqual([]);
    });

    it('导出/导入随备份走（原样字符串搬运）', () => {
        saveMcpServers([mkServer({ name: 'A' })]);
        const dump = exportMcpLocal();
        localStorage.removeItem('aetheros.mcp.servers');
        expect(loadMcpServers()).toEqual([]);
        importMcpLocal(dump);
        expect(loadMcpServers().map(s => s.name)).toEqual(['A']);
    });

    it('isMcpChatAvailable: 必须启用且已发现工具', () => {
        saveMcpServers([mkServer({ enabled: false })]);
        expect(isMcpChatAvailable()).toBe(false);
        saveMcpServers([mkServer({ tools: [] })]);
        expect(isMcpChatAvailable()).toBe(false);
        saveMcpServers([mkServer({})]);
        expect(isMcpChatAvailable()).toBe(true);
    });
});

describe('buildMcpOpenAITools', () => {
    it('转成 OpenAI function 格式，暴露名映射回 (server, 真实工具名)', () => {
        const s = mkServer({ tools: [{ name: 'my.tool/x', description: 'd', inputSchema: { type: 'object' } }] });
        saveMcpServers([s]);
        const { tools, resolve } = buildMcpOpenAITools();
        expect(tools).toHaveLength(1);
        // 点号斜杠等非法字符被替换成下划线
        expect(tools[0].function.name).toBe('my_tool_x');
        const hit = resolve.get('my_tool_x')!;
        expect(hit.toolName).toBe('my.tool/x');
        expect(hit.server.id).toBe(s.id);
    });

    it('跨服务器重名时后者加服务器名前缀，互不覆盖', () => {
        const a = mkServer({ name: 'AAA' });
        const b = mkServer({ name: 'BBB' });
        saveMcpServers([a, b]);
        const { tools, resolve } = buildMcpOpenAITools();
        expect(tools.map(t => t.function.name)).toEqual(['search', 'BBB_search']);
        expect(resolve.get('search')!.server.id).toBe(a.id);
        expect(resolve.get('BBB_search')!.server.id).toBe(b.id);
        // 多服务器时描述里带来源，帮模型区分
        expect(tools[0].function.description).toContain('[AAA]');
    });

    it('未启用 / 未发现工具的服务器不注入', () => {
        saveMcpServers([mkServer({ enabled: false }), mkServer({ tools: [] })]);
        expect(buildMcpOpenAITools().tools).toHaveLength(0);
    });
});
