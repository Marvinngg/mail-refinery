/**
 * 模型调用 + JSON 解析
 */

const config = require('../config.json');

async function callModel(prompt, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);

  const response = await fetch(`${config.model.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.model.api_key || 'none'}`
    },
    body: JSON.stringify({
      model: config.model.model_name,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 8000
    }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.choices[0].message.content || '';
}

function parseJSON(text) {
  const codeMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (codeMatch) return JSON.parse(codeMatch[1].trim());
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) return JSON.parse(arrMatch[0]);
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return JSON.parse(objMatch[0]);
  throw new Error(`No JSON found: ${text.slice(0, 200)}`);
}

/** 清理文件系统危险字符 */
function sanitizeName(name) {
  return (name || '').replace(/[\/\\:*?"<>|]/g, '-').trim();
}

module.exports = { callModel, parseJSON, sanitizeName };
