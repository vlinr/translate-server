import main, { getPath, ProcessStatus } from './transform'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'translate-server',
  version: '1.0.0',
})

const TranslateSchema = z.object({
  input: z.string(),
})

server.tool('translate', TranslateSchema.shape, async (config) => {
  // 获取argv传参，将JSON字符串转为json
  const args = process.argv.slice(2)
  // 内置一个模型
  let modelOptions = {
    apiKey: 'sk-abbxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
  }
  if (args.length) {
    try {
      const argvJson = JSON.parse(args[0])
      modelOptions = {
        ...modelOptions,
        ...argvJson,
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message: `'modelOptions' config error：${
                  (error as Error)?.message
                }`,
                success: false,
              },
              null,
              2,
            ),
          },
        ],
      }
    }
  }
  if (!config.input) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { message: 'inputDir is required', success: false },
            null,
            2,
          ),
        },
      ],
    }
  }
  const fileInfo = getPath(config.input)
  try {
    const result = await main(fileInfo, modelOptions)
    if (result === ProcessStatus.Success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                message: `Successfully translated ${fileInfo.input} to ${fileInfo.output}`,
                success: true,
              },
              null,
              2,
            ),
          },
        ],
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: `Failed to translate ${fileInfo.input} to ${fileInfo.output}`,
              success: false,
            },
            null,
            2,
          ),
        },
      ],
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: `Failed to translate ${fileInfo.input} to ${fileInfo.output}`,
              success: false,
            },
            null,
            2,
          ),
        },
      ],
    }
  }
})

const transport = new StdioServerTransport()

server
  .connect(transport)
  .then(() => {
    console.log('server connected')
  })
  .catch((error) => {
    console.error('server connect error', error)
  })
