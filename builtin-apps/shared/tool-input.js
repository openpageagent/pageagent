// Validate launch input from PageAgent.apps.open or POST /apps/{appId}/open.
export async function receiveToolInput(payload, entries, apply) {
  if (payload === null) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['toolId', 'operation', 'input'].includes(key))
    || typeof payload.input !== 'string' || typeof payload.toolId !== 'string' || !payload.toolId
    || payload.operation !== undefined && typeof payload.operation !== 'string') {
    throw new Error('启动参数须为 { toolId: 工具 ID, input: 文本, operation?: 操作 }。');
  }
  const entry = entries.find(entry => entry.id === payload.toolId);
  if (!entry) throw new Error('不支持接收内容的工具：' + payload.toolId);
  if (payload.operation !== undefined && !entry.operations.includes(payload.operation)) throw new Error('该工具不支持此启动操作：' + payload.operation);
  await apply({ ...payload, operation: payload.operation ?? entry.operations[0] });
}
