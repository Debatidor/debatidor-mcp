# @debatidor/mcp

Servidor oficial de **Model Context Protocol (MCP)** para Debatidor. Permite a entornos de desarrollo y clientes compatibles (Cursor, Claude Desktop, Antigravity, VS Code) consultar el estado del Agente Lead, recuperar contexto indexado e iniciar micro-debates entre modelos de IA.

## Instalación y Configuración

Añadir al archivo `mcp_config.json`:

```json
{
  "mcpServers": {
    "debatidor": {
      "command": "npx",
      "args": ["-y", "@debatidor/mcp"],
      "env": {
        "DEBATIDOR_API_KEY": "<TU_API_KEY>"
      }
    }
  }
}

