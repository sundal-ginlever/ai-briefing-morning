// src/providers/llm.js
// Unified LLM interface. Swap providers via LLM_PROVIDER env var.

import { config }                 from '../../config/index.js'
import { logger }                 from '../utils/logger.js'
import { withRetry, isRetryable } from '../utils/retry.js'

export async function generateScript(articles, override = {}) {
  const language      = override.briefing?.language      ?? config.briefing.language
  const targetSeconds = override.briefing?.targetSeconds ?? config.briefing.targetSeconds
  const customPrompt  = override.briefing?.customPrompt  ?? ''
  const systemPrompt  = buildSystemPrompt(language, targetSeconds, customPrompt)
  const userPrompt    = buildUserPrompt(articles)

  const provider = override.llm?.provider ?? config.llm.provider
  const model    = getModel(provider, override.llm?.model)

  logger.info(`[llm] provider="${provider}" model="${model}" customPrompt=${!!customPrompt}`)

  return withRetry(
    () => dispatch(provider, model, systemPrompt, userPrompt),
    { label: `llm:${provider}`, maxAttempts: 3, baseDelayMs: 2000, retryIf: isRetryable }
  )
}

function getModel(provider, overrideModel) {
  if (overrideModel) return overrideModel
  if (provider === 'openai') return config.llm.openai.model
  if (provider === 'gemini') return config.llm.gemini.model
  return config.llm.ollama.model
}

async function dispatch(provider, model, systemPrompt, userPrompt) {
  switch (provider) {
    case 'openai': return callOpenAI(model, systemPrompt, userPrompt)
    case 'gemini': return callGemini(model, systemPrompt, userPrompt)
    case 'ollama': return callOllama(model, systemPrompt, userPrompt)
    default: throw new Error(`Unknown LLM provider: ${provider}`)
  }
}

function buildSystemPrompt(language, targetSeconds, customPrompt) {
  const wordCount = Math.round(targetSeconds * 2.5)
  const basePrompt = `You are a professional, warm, and friendly morning news anchor.
Write an exceptionally engaging and conversational spoken audio briefing script in ${language}.
Target length: ${targetSeconds} seconds when read aloud (~${wordCount} words).
Style: conversational, warm, and natural — like a friendly NPR morning host speaking directly to a valued listener. Use cozy, welcoming tones and expressions (e.g. if in Korean, write in polite, warm colloquial style like "~입니다", "~인데요", "~라고 하네요", "~해 보시는 건 어떨까요?").
Pacing & Rhythm:
1. Use commas and periods for natural sentence breaks. Avoid ellipses (...) and em-dashes (—) — the text-to-speech engine reads them as long, breathy, whispered pauses rather than natural pacing.
2. Break long sentences into multiple short, punchy, conversational spoken-word phrases using periods, not dashes or ellipses.
Natural Pronunciation: Write exactly as the text should be spoken aloud. Spell out any foreign acronyms, numbers, or technical terms phonetically in ${language} to prevent the text-to-speech engine from reading them out letter-by-letter or sounding robotic (e.g., if ${language} is Korean, write "에이아이" or "인공지능" instead of "AI", "엔비디아" instead of "NVIDIA", "일조 원" instead of "1조원").
Separate each news story with a short, natural spoken transition (e.g. "Next up...", "In other news...", "Meanwhile...") so it flows smoothly as one continuous broadcast.
Write each story as its own paragraph, with a blank line between paragraphs (the intro greeting and closing sign-off may each be their own paragraph too).
Do NOT include stage directions, sound effects, timestamps, or bracketed markers like [PAUSE].
Output the script text only, nothing else.`

  if (!customPrompt) return basePrompt

  return `${basePrompt}

[USER CUSTOM INSTRUCTION]
${customPrompt}`
}

function buildUserPrompt(articles) {
  const lines = articles.map((a, i) =>
    `Story ${i + 1}:\nTitle: ${a.title}\nSource: ${a.source}\nDescription: ${a.description}`
  ).join('\n\n')
  return `Here are today's top news stories. Write the briefing script:\n\n${lines}`
}

async function callOpenAI(model, systemPrompt, userPrompt) {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey: config.llm.openai.apiKey })
  const res = await client.chat.completions.create({
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    temperature: 0.7,
  })
  const script = res.choices[0]?.message?.content?.trim()
  if (!script) throw new Error('OpenAI returned empty script')
  logger.info(`[llm:openai] ${script.length} chars`)
  return script
}

async function callGemini(model, systemPrompt, userPrompt) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai')
  const genAI = new GoogleGenerativeAI(config.llm.gemini.apiKey)
  const genModel = genAI.getGenerativeModel({
    model: model,
    systemInstruction: systemPrompt,
  })
  const result = await genModel.generateContent(userPrompt)
  const script = result.response.text()?.trim()
  if (!script) throw new Error('Gemini returned empty script')
  logger.info(`[llm:gemini] ${script.length} chars`)
  return script
}

async function callOllama(model, systemPrompt, userPrompt) {
  const { baseUrl } = config.llm.ollama
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`)
  const data   = await response.json()
  const script = data.message?.content?.trim()
  if (!script) throw new Error('Ollama returned empty script')
  logger.info(`[llm:ollama] model=${model} ${script.length} chars`)
  return script
}

/**
 * Filter and select the top count articles from candidate list using the Gemini model.
 * 
 * @param {Array} articles - Array of article candidates
 * @param {number} count - Number of articles to select
 * @param {object} override - Setting overrides
 * @returns {Promise<Array>} Selected articles
 */
export async function filterTopArticles(articles, count = 5, override = {}) {
  if (!articles || articles.length === 0) return [];
  if (articles.length <= count) {
    logger.info(`[llm-filter] Pool size (${articles.length}) <= target count (${count}), skipping AI filter`);
    return articles;
  }

  // As requested by the user, we explicitly enforce using the Gemini provider for this filtering task
  // unless they are using Ollama, but Gemini is the default.
  const provider = override.llm?.provider === 'ollama' ? 'ollama' : 'gemini';
  const model = provider === 'gemini' 
    ? (override.llm?.model || config.llm.gemini.model || 'gemini-2.5-flash')
    : getModel(provider, override.llm?.model);

  const systemPrompt = buildFilteringSystemPrompt(count);
  const userPrompt   = buildFilteringUserPrompt(articles);

  logger.info(`[llm-filter] Filtering ${articles.length} candidates down to ${count} using provider="${provider}" model="${model}"`);

  const responseText = await withRetry(
    () => dispatch(provider, model, systemPrompt, userPrompt),
    { label: `llm-filter:${provider}`, maxAttempts: 3, baseDelayMs: 2000, retryIf: isRetryable }
  );

  try {
    // Extract JSON array from the response (safeguard against markdown wrap or chat noise)
    const match = responseText.match(/\[\s*(\d+\s*,\s*)*\d+\s*\]/);
    if (match) {
      const indexes = JSON.parse(match[0]);
      logger.info(`[llm-filter] Selected indices: ${JSON.stringify(indexes)}`);
      
      const selected = indexes
        .map(idx => articles[idx])
        .filter(Boolean)
        .slice(0, count);

      if (selected.length > 0) {
        return selected;
      }
    }
    throw new Error(`Failed to parse indices from response: "${responseText}"`);
  } catch (e) {
    logger.warn(`[llm-filter] Curation failed: ${e.message}. Falling back to first ${count} candidates.`);
    return articles.slice(0, count);
  }
}

function buildFilteringSystemPrompt(count) {
  return `You are a chief news editor at a major global news broadcasting network.
Your task is to analyze a list of today's collected news stories and select the top ${count} most important, impactful, and trending news stories of the day.

Evaluation Criteria:
1. Impact: Prioritize major news stories (geopolitical shifts, macroeconomic updates, major tech/AI breakthroughs, global events) over minor interest pieces (individual product reviews, tutorials, local news, small package releases).
2. Trendiness: Select stories that represent hot topics or major discussions of the day.
3. Diversity: Ensure the selected stories cover a variety of topics, rather than selecting multiple articles about the exact same event, unless they are all critical.

You MUST respond ONLY with a raw JSON array of the 0-based indices of the selected ${count} articles, ordered by importance (most important first).
Example Output: [2, 5, 0, 8, 11]

Do NOT include any markdown formatting (like \`\`\`json), greetings, explanations, or introductory text. Just output the raw JSON array.`;
}

function buildFilteringUserPrompt(articles) {
  const lines = articles.map((a, i) =>
    `[Index ${i}]
Title: ${a.title}
Source: ${a.source || 'Unknown'}
Description: ${a.description || '(No description)'}
Published At: ${a.publishedAt || 'Unknown'}`
  ).join('\n\n');
  
  return `Here are today's news candidates. Select the top 5 most important/trending stories and return their indices in JSON format:\n\n${lines}`;
}
