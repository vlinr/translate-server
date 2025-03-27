import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import generate from '@babel/generator'
import fs from 'fs'
import path from 'path'
import { Node } from '@babel/types'
import concatModal from './concatModal'

export enum ProcessStatus {
  Success = 'success',
  Error = 'error',
}

// 获取节点的键名
function getKeyName(node: Node): string {
  if ('name' in node) {
    return node.name as string
  }
  if ('value' in node) {
    return String(node.value)
  }
  return ''
}

// 确保目录存在
function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

// 读取源代码文件
async function extractKeyValues(
  sourceCode: string,
  fileType: string,
  language: string,
  modalOptions: Record<string, string>,
): Promise<string> {
  try {
    // 如果是 JSON 文件，直接解析返回
    if (fileType === '.json') {
      try {
        const jsonData = JSON.parse(sourceCode)
        // 拆分jsonData
        const splitJsonData = splitJson(jsonData, 500)
        const result = await requestLLM(splitJsonData, language, modalOptions)
        return JSON.stringify(result, null, 2)
      } catch (error) {
        console.log(
          'Error:',
          error instanceof Error ? error.message : String(error),
        )
        return ''
      }
    } else {
      // 将代码解析成 AST
      const ast = parse(sourceCode, {
        sourceType: 'module',
        plugins: ['typescript'],
      })
      const translations: Record<string, string> = {}
      let hasValidTranslations = false
      // 遍历 AST - 收集数据
      traverse(ast, {
        ObjectProperty(path) {
          // 获取键名
          const key = getKeyName(path.node.key)
          // 获取值（如果是字符串字面量）
          if (path.node.value.type === 'StringLiteral') {
            const value = path.node.value.value
            translations[key] = value
            hasValidTranslations = true
          }
        },
      })

      if (hasValidTranslations) {
        const splitJsonData = splitJson(translations, 500) // 拆分翻译数据，对接大模型进行翻译
        // 等待翻译数据
        try {
          const result = await requestLLM(splitJsonData, language, modalOptions)
          if (result) {
            // 遍历 AST - 生成代码
            traverse(ast, {
              ObjectProperty(path) {
                const key = getKeyName(path.node.key)
                if (path.node.value.type === 'StringLiteral') {
                  const value = result[key]
                  const hasDoubleQuotes = value.includes('"')
                  const hasSingleQuotes = value.includes("'")
                  let quoteToUse = '"'
                  if (hasDoubleQuotes && !hasSingleQuotes) {
                    quoteToUse = "'"
                  }
                  path.node.value = {
                    type: 'StringLiteral',
                    value: value,
                    extra: {
                      raw: `${quoteToUse}${value}${quoteToUse}`,
                      rawValue: value,
                    },
                  }
                }
              },
            })

            const { code } = generate(ast, {
              retainLines: false,
              compact: false,
              jsescOption: {
                minimal: true,
              },
            })

            return code
              .replace(/\n{3,}/g, '\n\n')
              .replace(/^export default/gm, '\nexport default')
          }
        } catch (error) {
          console.log(
            'Error:',
            error instanceof Error ? error.message : String(error),
          )
          return ''
        }
      }
      return ''
    }
  } catch (error) {
    console.log(
      'Error:',
      error instanceof Error ? error.message : String(error),
    )
    return ''
  }
}

async function requestLLM(
  jsonList: Array<Record<string, string>>,
  language: string,
  modalOptions: Record<string, string>,
): Promise<Record<string, string>> {
  try {
    // 使用 Promise.all 处理并发请求
    const results = await Promise.all(
      jsonList.map(async (item) => {
        const result = await concatModal(
          JSON.stringify(item),
          language,
          modalOptions,
        )
        // 添加安全检查，确保返回的是纯JSON字符串
        function sanitizeJsonResponse(response: string): string {
          // 移除可能的markdown代码块标记
          response = response.replace(/```json\s*|\s*```/g, '')
          // 移除可能的前后空白字符
          response = response.trim()
          // 确保以 { 开头，} 结尾
          if (!response.startsWith('{') || !response.endsWith('}')) {
            throw new Error('Invalid JSON response format')
          }
          return response
        }
        // 在解析之前进行清理
        const cleanResult = sanitizeJsonResponse(result)
        return JSON.parse(cleanResult)
      }),
    )
    // 合并所有结果
    return results.reduce(
      (acc, curr) => ({
        ...acc,
        ...curr,
      }),
      {},
    )
  } catch (error) {
    throw error
  }
}

/**
 * 备份文件
 * @param {string} filePath - 需要备份的文件路径
 * @returns {string | null} 备份文件的路径
 */
function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const baseName = path.basename(filePath, ext)
  const timestamp = new Date().getTime()
  const backupPath = path.join(dir, `${baseName}.backup.${timestamp}${ext}`)

  fs.copyFileSync(filePath, backupPath)
  return backupPath
}

/**
 * 安全写入文件（如果文件存在则先备份）
 */
function safeWriteFile(
  filePath: string,
  content: string,
  options: fs.WriteFileOptions = {},
): void {
  if (fs.existsSync(filePath)) {
    backupFile(filePath)
  }
  fs.writeFileSync(filePath, content, options)
}

// 处理文件
async function processDirectory(
  fileInfo: FileInfo,
  modalOptions: Record<string, string>,
): Promise<ProcessStatus> {
  const { input, output, isFile } = fileInfo
  try {
    ensureDirectoryExists(isFile ? path.dirname(output) : output)
    const files = isFile ? [input] : fs.readdirSync(input)
    const supportedExtensions = ['.ts', '.js', '.json']
    await Promise.all(
      files.map(async (file) => {
        const fileExt = path.extname(file)
        // 从文件名中提取语言代码
        const langPattern = /[a-z]{2}-[A-Z]{2}|[a-z]{2}-[a-z]{2}/
        const match = path.basename(file).match(langPattern)
        const language = match ? match[0] : ''
        if (!supportedExtensions.includes(fileExt) || !language) {
          return Promise.resolve()
        }
        const inputPath = isFile ? input : path.join(input, file)
        const outputPath = isFile ? output : path.join(output, file)
        try {
          const sourceCode = fs.readFileSync(inputPath, 'utf-8')
          console.log(`File ${file} is running~`)
          const content = await extractKeyValues(
            sourceCode,
            fileExt,
            language,
            modalOptions,
          )
          if (content) {
            safeWriteFile(outputPath, content)
            console.log(
              `File ${inputPath} processing successfully，output location ${outputPath}.`,
            )
          } else {
            console.log(`File ${inputPath} processing failed.`)
          }
          return Promise.resolve()
        } catch (error) {
          console.log(`File ${inputPath} processing failed.`)
          return Promise.resolve()
        }
      }),
    )
    return ProcessStatus.Success
  } catch (error) {
    return ProcessStatus.Error
  }
}

/**
 * 将大的 JSON 对象拆分为多个小的 JSON 对象
 */
function splitJson(
  jsonData: Record<string, string>,
  maxKeysPerChunk: number = 100,
): Array<Record<string, string>> {
  const entries = Object.entries(jsonData)
  const totalEntries = entries.length
  const totalChunks = Math.ceil(totalEntries / maxKeysPerChunk)
  const result: Array<Record<string, string>> = []

  for (let i = 0; i < totalChunks; i++) {
    const start = i * maxKeysPerChunk
    const end = Math.min(start + maxKeysPerChunk, totalEntries)
    const currentEntries = entries.slice(start, end)
    const chunk = Object.fromEntries(currentEntries)
    result.push(chunk)
  }

  return result
}

// 提取路径
export const getPath = (input: string, dist: string = 'dist') => {
  // 获取输入路径的绝对路径
  const absolutePath = path.isAbsolute(input) ? input : path.resolve('.', input)
  try {
    // 检查路径是否存在
    const stats = fs.statSync(absolutePath)
    if (stats.isFile()) {
      const dirName = path.dirname(absolutePath)
      const fileName = path.basename(absolutePath)
      return {
        input: path.join(dirName, fileName),
        output: path.join(dirName, dist, fileName),
        isFile: true,
      }
    } else if (stats.isDirectory()) {
      return {
        input: path.join(absolutePath),
        output: path.join(absolutePath, dist),
        isFile: false,
      }
    }
  } catch (error) {
    return {
      input: path.join(absolutePath),
      output: path.join(absolutePath, dist),
      isFile: false,
    }
  }
  return {
    input: path.join(absolutePath),
    output: path.join(absolutePath, dist),
    isFile: false,
  }
}

type FileInfo = {
  input: string
  output: string
  isFile?: boolean
}

// 主函数：处理输入目录并保存到输出目录
async function main(
  fileInfo: FileInfo,
  modalOptions: Record<string, string>,
): Promise<ProcessStatus> {
  return await processDirectory(fileInfo, modalOptions)
}

// 执行主函数
export default main
