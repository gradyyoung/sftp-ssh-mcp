#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client as SSHClient } from 'ssh2';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// 解析命令行参数
function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string> = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      config[match[1]] = match[2];
    }
  }
  return config;
}
const argvConfig = parseArgv();

const HOST = argvConfig.host;
const PORT = argvConfig.port ? parseInt(argvConfig.port) : 22;
const USER = argvConfig.user;
const PASSWORD = argvConfig.password;
const KEY = argvConfig.key;

// 配置验证
function validateConfig(config: Record<string, string>) {
  const errors = [];
  if (!config.host) errors.push('Missing required --host');
  if (!config.user) errors.push('Missing required --user');
  if (config.port && isNaN(Number(config.port))) errors.push('Invalid --port');
  if (errors.length > 0) {
    throw new Error('Configuration error:\n' + errors.join('\n'));
  }
}

validateConfig(argvConfig);

// MCP 服务器实例化
const server = new McpServer({
  name: 'SSH MCP Server', // 服务器名称
  version: '1.0.5', // 服务器版本
  capabilities: { // 服务器能力
    resources: {}, // 资源能力
    tools: {}, // 工具能力
  },
});

// 实现 SFTP 上传工具
server.tool(
  "sftp_upload", // 工具名称
  "Upload a file to remote server via SFTP", // 工具描述
  { // 工具参数
    localPath: z.string().describe("Local file path to upload"),
    remotePath: z.string().describe("Remote path to save the file"),
  },
  async ({ localPath, remotePath }) => { // 工具实现
    try {
      const fs = await import('fs/promises');
      const fileData = await fs.readFile(localPath);
      const sshConfig: any = {
        host: HOST,
        port: PORT,
        username: USER,
      };
      if (PASSWORD) {
        sshConfig.password = PASSWORD;
      } else if (KEY) {
        sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
      }
      await execSftpCommand(sshConfig, 'upload', fileData, remotePath);
      return {
        content: [{ // 返回结果
          type: 'text', // 结果类型
          text: `File uploaded to ${remotePath}` // 结果文本
        }]
      };
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Upload failed: ${err?.message || err}`);
    }
  }
);

// 实现 SFTP 下载工具
server.tool(
  "sftp_download",
  "Download a file from remote server via SFTP",
  {
    remotePath: z.string().describe("Remote file path to download"),
    localPath: z.string().describe("Local path to save the file"),
  },
  async ({ remotePath, localPath }) => {
    try {
      const fs = await import('fs/promises');
  // 重新构建 sshConfig 对象以解决找不到名称的问题
  const sshConfig: any = {
    host: HOST,
    port: PORT,
    username: USER,
  };
  if (PASSWORD) {
    sshConfig.password = PASSWORD;
  } else if (KEY) {
    const fs = await import('fs/promises');
    sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
  }
  const result = await execSftpCommand(sshConfig, 'download', remotePath);
  // 由于 result 类型为 unknown，需要确保它是 Buffer 类型才能传递给 fs.writeFile
  if (result instanceof Buffer) {
    await fs.writeFile(localPath, result);
  } else {
    throw new McpError(ErrorCode.InternalError, `Download failed: 期望结果为 Buffer 类型，但得到 ${typeof result}`);
  }
      return { content: [{ type: 'text', text: `File downloaded to ${localPath}` }] };
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Download failed: ${err?.message || err}`);
    }
  }
);

// 实现 SFTP 列表工具
server.tool(
  "sftp_list",
  "List files in a remote directory via SFTP",
  {
    remotePath: z.string().describe("Remote directory path to list"),
  },
  async ({ remotePath }) => {
    try {
      const sshConfig: any = {
        host: HOST,
        port: PORT,
        username: USER,
      };
      if (PASSWORD) {
        sshConfig.password = PASSWORD;
      } else if (KEY) {
        const fs = await import('fs/promises');
        sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
      }
      const list = await execSftpCommand(sshConfig, 'list', remotePath) as { filename: string, longname: string }[];
      return {
        content: [{
          type: 'text',
          text: list.map(item => `${item.filename} (${item.longname})`).join('\n')
        }]
      };
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `List failed: ${err?.message || err}`);
    }
  }
);

// 执行 SFTP 命令
async function execSftpCommand(sshConfig: any, action: string, ...args: any[]) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          reject(new McpError(ErrorCode.InternalError, `SFTP error: ${err.message}`));
          conn.end();
          return;
        }

        switch (action) {
          case 'upload': {
            const [data, remotePath] = args;
            const writeStream = sftp.createWriteStream(remotePath);
            writeStream.write(data);
            writeStream.end();
            writeStream.on('close', () => {
              resolve({ content: [{ type: 'text', text: `File uploaded to ${remotePath}` }] });
              conn.end();
            });
            break;
          }
          case 'download': {
            const [remotePath] = args;
            const readStream = sftp.createReadStream(remotePath);
            let data = Buffer.from('');
            readStream.on('data', (chunk: Buffer) => {
              data = Buffer.concat([data, chunk]);
            });
            readStream.on('end', () => {
              resolve(data);
              conn.end();
            });
            break;
          }
          case 'list': {
            const [remotePath] = args;
            sftp.readdir(remotePath, (err, list) => {
              if (err) {
                reject(new McpError(ErrorCode.InternalError, `List error: ${err.message}`));
                conn.end();
                return;
              }
              resolve({
                content: [{
                  type: 'text',
                  text: list.map(item => `${item.filename} (${item.longname})`).join('\n'),
                }],
              });
              conn.end();
            });
            break;
          }
          default:
            reject(new McpError(ErrorCode.InternalError, 'Invalid SFTP action'));
            conn.end();
        }
      });
    });
    conn.on('error', (err) => {
      reject(new McpError(ErrorCode.InternalError, `SFTP connection error: ${err.message}`));
    });
    conn.connect(sshConfig);
  });
}

server.tool(
  "exec",
  "Execute a shell command on the remote SSH server and return the output.",
  {
    command: z.string().describe("Shell command to execute on the remote SSH server"),
  },
  async ({ command }) => {
    // Sanitize command input
    if (typeof command !== 'string' || !command.trim()) {
      throw new McpError(ErrorCode.InternalError, 'Command must be a non-empty string.');
    }
    const sshConfig: any = {
      host: HOST,
      port: PORT,
      username: USER,
    };
    try {
      if (PASSWORD) {
        sshConfig.password = PASSWORD;
      } else if (KEY) {
        const fs = await import('fs/promises');
        sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
      }
      const result = await execSshCommand(sshConfig, command);
      return result;
    } catch (err: any) {
      // Wrap unexpected errors
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    }
  }
);

async function execSshCommand(sshConfig: any, command: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          conn.end();
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number, signal: string) => {
          conn.end();
          if (stderr) {
            reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
          } else {
            resolve({
              content: [{
                type: 'text',
                text: stdout,
              }],
            });
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
    conn.on('error', (err) => {
      reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
    });
    conn.connect(sshConfig);
  });
}

// 启动 MCP 服务器
async function main() {
  // 比较简单的启动方式，直接连接到 stdio
  const transport = new StdioServerTransport();
  // 监听 stdio 输入，处理 MCP 请求
  await server.connect(transport);
  console.error("SSH MCP Server running on stdio");
}

// 启动服务器，处理错误
main().catch((error) => {
  // 处理启动过程中的错误
  console.error("Fatal error in main():", error);
  process.exit(1);
});