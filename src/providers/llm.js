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
  const basePrompt = `You are a professional morning news anchor.
Write a spoken audio briefing script in ${language}.
Target length: ${targetSeconds} seconds when read aloud (~${wordCount} words).
Style: warm, clear, conversational — like NPR morning edition.
Do NOT include stage directions, sound effects, or timestamps.
Output the script text only, nothing else.`

  if (!customPrompt) return basePrompt

  return `${basePrompt}

[USER CUSTOM INSTRUCTION]
${customPrompt}`
}

function buildUserPrompt(articles) {
  const lines = articles.map((a, i) =>
    `${i + 1}. [${a.source}] ${a.title}\n   ${a.description}`
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
