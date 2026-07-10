/**
 * 通用 MCP → 聊天工具循环 的桥接层（对标 luckinToolBridge 的角色分工）
 *
 * 职责：
 * 1. 把所有启用 MCP 服务器的已发现工具聚合成 OpenAI function-calling 格式
 * 2. 处理跨服务器工具重名 / OpenAI 工具名字符限制（暴露名 ↔ 真实工具映射）
 * 3. 生成注入 systemPrompt 的说明块
 * 工具循环本体在 hooks/useChatAI.ts（对标 luckinChat 循环）。
 */

import { getEnabledMcpServers, type McpServerConfig, type McpToolDef } from './mcpClient';

export interface OpenAIMcpTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

export interface ResolvedMcpTool {
    server: McpServerConfig;
    toolName: string;
}

// OpenAI 工具名只允许 [A-Za-z0-9_-]，最长 64；MCP 工具名可能带点号等
const sanitizeToolName = (name: string): string =>
    (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';

const serverSlug = (server: McpServerConfig): string =>
    sanitizeToolName(server.name).slice(0, 20) || 'srv';

/**
 * 聚合启用服务器的工具，返回 OpenAI 工具数组 + 暴露名→真实工具 的映射。
 * 暴露名默认用工具原名（sanitize 后）；跨服务器重名时后者加 <服务器名>_ 前缀。
 */
export const buildMcpOpenAITools = (): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const tools: OpenAIMcpTool[] = [];
    const resolve = new Map<string, ResolvedMcpTool>();
    for (const server of getEnabledMcpServers()) {
        for (const t of server.tools || []) {
            let exposed = sanitizeToolName(t.name);
            if (resolve.has(exposed)) {
                exposed = sanitizeToolName(`${serverSlug(server)}_${t.name}`);
                let i = 2;
                while (resolve.has(exposed)) exposed = sanitizeToolName(`${serverSlug(server)}_${t.name}_${i++}`);
            }
            resolve.set(exposed, { server, toolName: t.name });
            tools.push({
                type: 'function',
                function: {
                    name: exposed,
                    description: buildToolDescription(server, t),
                    parameters: t.inputSchema || { type: 'object', properties: {} },
                },
            });
        }
    }
    return { tools, resolve };
};

const buildToolDescription = (server: McpServerConfig, t: McpToolDef): string => {
    const desc = (t.description || '').trim();
    // 多服务器时在描述里带上来源，帮模型区分同类工具
    const multi = getEnabledMcpServers().length > 1;
    return multi ? `[${server.name}] ${desc}` : desc;
};

// ========== 提示词 ==========

/**
 * MCP 工具模式的 systemPrompt 说明块。
 * 与瑞幸不同：这里的工具是用户自配的、内容未知，所以只讲纪律，不讲业务流程。
 */
export const buildMcpSystemBlock = (userName: string = '用户'): string => {
    const servers = getEnabledMcpServers();
    if (!servers.length) return '';
    const lines = servers.map(s => {
        const names = (s.tools || []).map(t => t.name).join('、');
        return `- ${s.name}: ${names}`;
    });
    return `

---
[外部工具已接入 —— ${userName} 在设置里给你连了 MCP 工具服务器]

**核心**: 你还是原来的角色、原来的语气、原来的记忆。工具只是你顺手能用的能力，**每轮都要有角色化的文字**，别干巴巴报结果。

可用工具来源:
${lines.join('\n')}

**使用纪律**:
- 需要时直接调工具（系统会自动执行并把结果给你），不需要时正常聊天，**别硬找理由调工具**。
- 工具结果只挑与对话相关的部分用角色语气转述，别整段复读 JSON。
- 工具失败就如实说，并根据报错调整参数重试或换个方式，别编造结果。
- 涉及真实世界副作用的操作（发布内容、下单、删除等），先跟 ${userName} 确认一句再动手。
---
`;
};

/** 尾部小提醒（注入 messages 末尾，防长对话把纪律冲掉） */
export const MCP_TAIL_REMINDER = `[MCP 工具 ON · 永远用角色语气回复别空回; 工具结果别复读 JSON; 有副作用的操作先确认再执行]`;
