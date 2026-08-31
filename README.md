# @debatidor/mcp

Servidor remoto oficial de **Model Context Protocol (MCP)** para Debatidor.

`debatidor-mcp` es un adaptador fino entre clientes MCP (ChatGPT, Claude, Gemini, IDEs y agentes compatibles) y `debatidor-back`. La autoridad de identidad, permisos, Arena, Lead y datos permanece en el backend.

## Arquitectura

```text
ChatGPT / Claude / Gemini / IDEs
              |
        Streamable HTTP
              |
   https://mcp.debatidor.com/mcp
              |
        debatidor-mcp
              |
        OAuth bearer
              |
        debatidor-back
```

El endpoint remoto es el camino principal. `stdio` se conserva únicamente para clientes locales/IDE y debugging.

## Estado actual

Versión `0.4.0`:

- MCP TypeScript SDK v2, compatible con la revisión `2026-07-28`;
- Streamable HTTP stateless en `/mcp`;
- Docker + healthcheck `/health` y `/healthz`;
- Protected Resource Metadata en `/.well-known/oauth-protected-resource`;
- OAuth 2.1 requerido en el endpoint HTTPS de producción;
- `debatidor_ping` para comprobación del servicio;
- `debatidor_get_lead_status` disponible con el principal OAuth del usuario;
- `debatidor_search_context` para búsqueda semántica read-only sobre la memoria vectorial del workspace;
- bridge API-key legacy conservado únicamente para dogfooding local/privado y mutuamente excluyente con OAuth.

El bootstrap `0.2.0` fue validado desde una conversación real de ChatGPT Developer Mode. La vertical `0.3.0` añadió account linking user-scoped y `0.4.0` incorpora la primera capacidad de contexto persistente sin ampliar privilegios de escritura.

## Desarrollo local

```bash
npm install
npm run check
npm test
npm run build
```

Para probar HTTP local sin OAuth remoto:

```bash
DEBATIDOR_MCP_HOST=127.0.0.1 \
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002 \
DEBATIDOR_MCP_OAUTH_ENABLED=false \
npm run dev:http
```

Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

## Producción

Endpoint canónico:

```text
https://mcp.debatidor.com/mcp
```

Variables recomendadas:

```env
NODE_ENV=production
DEBATIDOR_MCP_HOST=0.0.0.0
DEBATIDOR_MCP_PORT=3002
DEBATIDOR_MCP_PUBLIC_BASE_URL=https://mcp.debatidor.com
DEBATIDOR_MCP_ALLOWED_HOSTS=mcp.debatidor.com
DEBATIDOR_MCP_OAUTH_ENABLED=true
DEBATIDOR_MCP_AUTHORIZATION_SERVER=https://api.debatidor.com
DEBATIDOR_API_BASE_URL=https://api.debatidor.com
DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=false
```

No configures `DEBATIDOR_API_KEY` en el endpoint público.

### OAuth / account linking

El MCP actúa como OAuth Resource Server y `debatidor-back` como Authorization Server.

```text
GET /.well-known/oauth-protected-resource
        -> authorization_servers: https://api.debatidor.com

ChatGPT
  -> Authorization Code + PKCE S256
  -> CIMD client identity
  -> consentimiento Debatidor
  -> access token user-scoped
  -> Authorization: Bearer <token> en /mcp
```

El access token se valida contra el backend antes de crear las tools de la request. Por eso las tools user-scoped heredan el workspace del usuario conectado y no una API key global del contenedor.

Para el primer dogfood, el navegador debe tener una sesión válida de Debatidor antes de comenzar el consentimiento. La redirección automática a login cuando no hay sesión es polish posterior.

## Tools

### `debatidor_ping`

Comprueba versión/protocolo/reachability. No devuelve datos privados.

### `debatidor_get_lead_status`

Lee Arenas `LEAD` visibles en el workspace del principal OAuth. Con `debateId`, valida primero ownership mediante el listado workspace-scoped antes de consultar el snapshot.

### `debatidor_search_context`

Busca semánticamente recuerdos `MESSAGE` y `CONCLUSION` de la memoria vectorial de largo plazo del workspace autenticado. Admite `debateId`, filtro de `kinds` y hasta 10 resultados por llamada desde MCP.

La consulta es read-only y el aislamiento de tenant ocurre en `debatidor-back`: `workspace_id` es la primera cláusula del `WHERE` de búsqueda, no un filtro posterior. Para generar el embedding de la consulta, el backend usa la llave OpenAI configurada por el usuario en la bóveda BYOK de Debatidor; el MCP nunca recibe ni reenvía esa llave.

Siguiente tool de P7:

- `debatidor_quick_debate`

## ChatGPT, Claude y Gemini

El core no contiene adapters específicos por proveedor. Todos deben consumir el mismo MCP remoto.

- ChatGPT: Developer Mode / MCP app; primer cliente de aceptación.
- Claude: Custom Connector remote MCP; segundo cliente de portabilidad previsto.
- Gemini y otros hosts: mismo endpoint cuando su producto soporte remote MCP compatible.

CIMD es la ruta principal de identificación OAuth. DCR se añadirá solo como fallback de interoperabilidad si un cliente objetivo todavía lo exige.

## stdio / bridge legacy

Para dogfooding privado puede deshabilitarse OAuth y usar una API key:

```env
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002
DEBATIDOR_MCP_OAUTH_ENABLED=false
DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=true
DEBATIDOR_API_KEY=deb_live_xxx
```

Nunca uses este modo en `mcp.debatidor.com`.

## Seguridad

- No hay una API key global de usuario embebida en producción.
- El MCP valida bearer tokens antes de exponer tools user-scoped.
- El backend valida audience/resource/scope y conserva autoridad de tenant/ownership.
- La búsqueda de contexto permanece workspace-scoped en el backend y no expone embeddings ni claves de proveedor.
- Authorization codes y refresh tokens se almacenan hasheados; los refresh tokens rotan.
- No loguear tokens, códigos OAuth, API keys ni payloads sensibles completos.
- Las futuras tools de escritura deben declarar annotations MCP correctas y respetar autorización/confirmación del cliente.
