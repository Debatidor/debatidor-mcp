# @debatidor/mcp

Servidor oficial de **Model Context Protocol (MCP)** para Debatidor.

El objetivo es exponer Arena, Lead y memoria de Debatidor a clientes compatibles con MCP sin duplicar lógica de negocio. `debatidor-mcp` es un adaptador fino; la autoridad de identidad, permisos y datos permanece en `debatidor-back`.

## Estado actual

Primera vertical de P7:

- MCP TypeScript SDK v2 (`2026-07-28`).
- Streamable HTTP en `POST /mcp`.
- Transporte stdio para clientes locales.
- Tool read-only `debatidor_get_lead_status`.
- Cliente HTTP contra `debatidor-back` usando `DEBATIDOR_API_KEY` solo como puente de dogfooding.
- El servidor HTTP **solo permite loopback** por ahora. No se debe publicar directamente hasta implementar OAuth MCP.

## Requisitos

- Node.js 22+
- Una API key de Debatidor para el entorno de desarrollo

```bash
cp .env.example .env
npm install
npm run check
npm test
```

## HTTP local

```bash
DEBATIDOR_API_KEY=deb_live_xxx npm run dev:http
```

Endpoint:

```text
http://127.0.0.1:3000/mcp
```

Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Selecciona **Streamable HTTP** y usa `http://127.0.0.1:3000/mcp`.

## stdio

```bash
DEBATIDOR_API_KEY=deb_live_xxx npm run dev:stdio
```

Tras publicar el paquete, clientes locales podrán lanzar:

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
```

## Tool inicial

### `debatidor_get_lead_status`

Devuelve las Arenas en modo `LEAD` visibles en el workspace autenticado. Con `debateId` devuelve además los participantes del debate.

La implementación valida primero que el debate aparezca en `GET /realtime/debates` para el workspace antes de consultar el snapshot. Esto evita exponer por MCP un `debateId` ajeno mientras el endpoint legacy de snapshot termina de endurecer ownership en backend.

## ChatGPT, Claude y Gemini

El core no contiene adaptadores por proveedor: habla MCP estándar. La misma implementación de tools debe funcionar en cualquier cliente que soporte el transporte y la revisión negociada.

Para el primer dogfood con ChatGPT se recomienda mantener el proceso en loopback y usar **Secure MCP Tunnel** en Developer mode. No expongas este build a Internet: todavía usa una API key server-side y no implementa autorización OAuth por usuario.

La siguiente fase de P7 implementará autorización MCP/OAuth 2.1 con PKCE y Protected Resource Metadata. Para interoperabilidad durante la transición del ecosistema, el diseño deberá priorizar **Client ID Metadata Documents (CIMD)** y conservar **Dynamic Client Registration (DCR)** como fallback mientras clientes como Gemini/otros aún lo utilicen.

Con OAuth listo, el mismo endpoint remoto `/mcp` será el objetivo para:

- ChatGPT Plugins / MCP connections.
- Claude custom connectors por remote MCP.
- Gemini Spark custom Connected Apps.
- otros hosts MCP como VS Code, Cursor y clientes compatibles.

## Seguridad

- No loguear `DEBATIDOR_API_KEY` ni resultados sensibles completos.
- No permitir bind público sin OAuth.
- Toda tool que acepte un `debateId` debe validar ownership por workspace antes de leer o mutar datos.
- Las futuras tools de escritura deben declarar annotations MCP correctas y conservar aprobación del cliente/usuario cuando aplique.
