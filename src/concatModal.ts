import OpenAI from 'openai'
import { ASSISTANT_PROMPT, SYSTEM_PROMPT, getUserPrompt } from './prompts'

interface ConcatModalOptions {
  maxRetries?: number
  retryDelay?: number
  timeout?: number
}

async function concatModal(
  content: string,
  language: string,
  options: ConcatModalOptions = {},
): Promise<string> {
  const {
    maxRetries = 3,
    retryDelay = 1000,
    timeout = 600000,
    ...rest
  } = options
  const openai = new OpenAI({
    ...rest,
    timeout: timeout,
  })

  async function makeRequest(retryCount = 0): Promise<string> {
    try {
      const response = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: getUserPrompt(content, language) },
          { role: 'assistant', content: ASSISTANT_PROMPT },
        ],
      })
      // 需要判断翻译结果是否一个有效的JSON
      return response.choices[0].message.content || ''
    } catch (error) {
      if (retryCount < maxRetries) {
        console.log(
          `翻译请求失败，正在进行第 ${retryCount + 1}/${maxRetries} 次重试...`,
        )
        // 使用指数退避策略
        const delay = retryDelay * Math.pow(2, retryCount)
        await new Promise((resolve) => setTimeout(resolve, delay))
        return makeRequest(retryCount + 1)
      }
      console.error(
        '翻译失败，已达到最大重试次数:',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  return makeRequest()
}

export default concatModal
