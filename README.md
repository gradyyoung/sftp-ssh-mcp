**SFTP-SSH MCP Server** is a local Model Context Protocol (MCP) server that exposes SFTP-SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.


# Client Setup

You can configure Claude Desktop to use this MCP Server.
   - `host`: Hostname or IP of the Linux or Windows server
   - `port`: SSH port (default: 22)
   - `user`: SSH username
   - `password`: SSH password (or use `key` for key-based auth) (optional)
   - `key`: Path to private SSH key (optional)


```commandline
{
    "mcpServers": {
        "sftp-ssh-mcp": {
            "command": "npx",
            "args": [
                "sftp-ssh-mcp",
                "-y",
                "--",
                "--host=1.2.3.4",
                "--port=22",
                "--user=root",
                "--password=pass",
                "--key=path/to/key"
            ]
        }
    }
}
```