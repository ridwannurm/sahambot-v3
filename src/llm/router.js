// src/llm/router.js — Multi-LLM Router dengan intent classifier
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { loadEnv } from '../config.js';

// ── Provider Configs ─────────────────────────────────────────
export const LLM_PROVIDERS = {
  claude: {
    name: 'Claude (Anthropic)',
    models: ['claude-opus-4-5-20251101', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-20250514',
    envKey: 'ANTHROPIC_API_KEY'
  },
  openai: {
    name: 'OpenAI / ChatGPT',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY'
  },
  groq: {
    name: 'Groq (Ultra Fast)',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    defaultModel: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY'
  },
  gemini: {
    name: 'Google Gemini',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.0-flash',
    envKey: 'GEMINI_API_KEY'
  },
  ollama: {
    name: 'Ollama (Local)',
    models: ['llama3', 'mistral', 'phi3', 'gemma2'],
    defaultModel: 'llama3',
    envKey: null
  }
};

// ── Intent Classifier ────────────────────────────────────────
export function classifyIntent(text) {
  const t = text.toLowerCase();

  // Watchlist management
  if (/tambah|add|masukin|pantau/.test(t) && /saham|emiten|kode/.test(t)) return 'WATCHLIST_ADD';
  if (/hapus|remove|buang|keluarkan/.test(t) && /saham|watchlist/.test(t)) return 'WATCHLIST_REMOVE';
  if (/watchlist|daftar saham|pantauan/.test(t)) return 'WATCHLIST_LIST';

  // Analysis
  if (/analisis|analisa|cek|lihat|gimana|bagaimana/.test(t) && /scalp/.test(t)) return 'SCALP_ANALYSIS';
  if (/analisis|analisa|cek|lihat|gimana|bagaimana/.test(t)) return 'STOCK_ANALYSIS';

  // Scan
  if (/scan|cari|temukan|peluang/.test(t)) return 'SCAN';

  // Settings / LLM
  if (/ganti|ubah|pakai|gunakan/.test(t) && /ai|model|llm|claude|gpt|groq|gemini/.test(t)) return 'CHANGE_LLM';
  if (/model|llm|ai mana|pakai apa/.test(t)) return 'LIST_MODELS';

  // Risk
  if (/risk|risiko|sizing|modal|position/.test(t)) return 'RISK_CALC';

  // Performance
  if (/performa|win rate|history|riwayat|statistik/.test(t)) return 'PERFORMANCE';

  // Alert
  if (/alert|notif|kasih tahu|beritahu/.test(t)) return 'SET_ALERT';

  // Trading
  if (/\/entry|buka posisi|masuk posisi|buy signal/.test(t)) return 'ENTRY_FLOW';
  if (/\/exit|tutup posisi|keluar posisi|cut loss/.test(t)) return 'EXIT_FLOW';
  if (/posisi|portfolio|holding/.test(t)) return 'POSITIONS';
  if (/report|laporan|performa|win rate|winrate/.test(t)) return 'REPORT';
  if (/history|riwayat|histori/.test(t)) return 'HISTORY';

  // Konglo
  if (/konglo|konglomerat|grup|salim|bakrie|hartono|djarum|thohir|sinarmas|astra|riady|aguan|prajogo/.test(t)) return 'KONGLO';

  // Top movers
  if (/top gainer|topgainer|saham naik|naik terbanyak/.test(t)) return 'TOP_GAINERS';
  if (/top loser|toploser|saham turun|turun terbanyak/.test(t)) return 'TOP_LOSERS';

  // Volume
  if (/top volume|volume terbesar|volume tinggi|saham ramai|paling ramai|aktif hari ini/.test(t)) return 'TOP_VOLUME';
  if (/volume spike|spike volume|lonjakan volume|volume meledak|unusual volume/.test(t)) return 'VOLUME_SPIKE';

  // Smart money
  if (/smart money|akumulasi|distribusi|pergerakan serentak/.test(t)) return 'KONGLO';

  // ARA ARB
  if (/ara|arb|auto reject|batas atas|batas bawah/.test(t)) return 'ARA_ARB';

  // Help
  if (/help|bantuan|bisa apa|fitur|command/.test(t)) return 'HELP';

  // Compare AI
  if (/banding|compare|vs|versus/.test(t) && /ai|model|llm/.test(t)) return 'COMPARE_AI';

  // Dashboard
  if (/dashboard|pantau|monitor|live/.test(t)) return 'DASHBOARD';

  // Default: free chat
  return 'FREE_CHAT';
}

// ── Call LLM ─────────────────────────────────────────────────
export async function callLLM({ provider = 'claude', model, systemPrompt, messages, maxTokens = 1000 }) {
  const env = loadEnv();
  const cfg = LLM_PROVIDERS[provider];
  if (!cfg) throw new Error(`Provider '${provider}' tidak dikenal`);

  const mdl = model || cfg.defaultModel;

  // ── Claude ──────────────────────────────────────────────
  if (provider === 'claude') {
    const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY tidak ditemukan di .env');
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: mdl, max_tokens: maxTokens,
      system: systemPrompt,
      messages
    });
    return { text: res.content[0].text, provider: 'claude', model: mdl };
  }

  // ── OpenAI / ChatGPT ────────────────────────────────────
  if (provider === 'openai') {
    const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY tidak ditemukan di .env');
    const client = new OpenAI({ apiKey });
    const res = await client.chat.completions.create({
      model: mdl, max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    });
    return { text: res.choices[0].message.content, provider: 'openai', model: mdl };
  }

  // ── Groq ────────────────────────────────────────────────
  if (provider === 'groq') {
    const apiKey = env.GROQ_API_KEY || process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY tidak ditemukan di .env');
    const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
    const res = await client.chat.completions.create({
      model: mdl, max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    });
    return { text: res.choices[0].message.content, provider: 'groq', model: mdl };
  }

  // ── Gemini ──────────────────────────────────────────────
  if (provider === 'gemini') {
    const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY tidak ditemukan di .env');
    const allMsgs = [{ role: 'system', content: systemPrompt }, ...messages];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return { text: data.candidates[0].content.parts[0].text, provider: 'gemini', model: mdl };
  }

  // ── Ollama (local) ──────────────────────────────────────
  if (provider === 'ollama') {
    const baseURL = env.OLLAMA_URL || 'http://localhost:11434';
    const res = await fetch(`${baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: mdl, stream: false,
        messages: [{ role: 'system', content: systemPrompt }, ...messages]
      })
    });
    const data = await res.json();
    return { text: data.message?.content || 'No response', provider: 'ollama', model: mdl };
  }

  throw new Error(`Provider '${provider}' belum diimplementasikan`);
}

// ── Multi-model Parallel Compare ─────────────────────────────
export async function compareAI(providers, systemPrompt, userMessage) {
  const tasks = providers.map(async ({ provider, model }) => {
    try {
      const result = await callLLM({
        provider, model, systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 600
      });
      return { ...result, success: true };
    } catch (e) {
      return { provider, model, text: `Error: ${e.message}`, success: false };
    }
  });
  return Promise.all(tasks);
}
