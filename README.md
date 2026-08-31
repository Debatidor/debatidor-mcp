# @debatidor/mcp

Servidor remoto oficial de **Model Context Protocol (MCP)** para Debatidor.

`debatidor-mcp` es un adaptador fino entre clientes MCP (ChatGPT, Claude, Gemini, IDEs y agentes compatibles) y `debatidor-back`. La autoridad de identidad, permisos, Arena, Lead, memoria y datos permanece en el backend.

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

Versión `0.5.0`:

- MCP TypeScript SDK v2, compatible con la revisión `2026-07-28`;
- Streamable HTTP stateless en `/mcp`;
- Docker + healthcheck `/health` y `/healthz`;
- Protected Resource Metadata en `/.well-known/oauth-protected-resource`;
- OAuth 2.1 requerido en el endpoint HTTPS de producción;
- `debatidor_ping` para comprobación del servicio;
- `debatidor_get_lead_status` para Arenas `LEAD` del workspace autenticado;
- `debatidor_search_context` para búsqueda semántica read-only;
- `debatidor_index_context` para materializar explícitamente mensajes persistidos como memoria semántica;
- bridge API-key legacy únicamente para dogfooding local/privado y mutuamente excluyente con OAuth.

El bootstrap `0.2.0` fue validado desde ChatGPT real; `0.3.0` añadió account linking user-scoped; `0.4.0` incorporó búsqueda semántica y `0.5.0` separa explícitamente el coste/escritura de indexación de la consulta read-only.

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

El access token se valida contra el backend antes de crear las tools user-scoped. El MCP nunca usa una API key global del contenedor para representar usuarios.

## Tools

### `debatidor_ping`

Comprueba versión/protocolo/reachability. No devuelve datos privados.

### `debatidor_get_lead_status`

Lee Arenas `LEAD` visibles en el workspace del principal OAuth. Con `debateId`, valida ownership antes de leer detalle.

### `debatidor_search_context`

Busca semánticamente recuerdos `MESSAGE` y `CONCLUSION` del workspace autenticado. Admite `debateId`, filtro de `kinds` y hasta 10 resultados por llamada MCP.

La consulta es **read-only**. El backend genera el embedding de la query con la llave OpenAI BYOK del usuario y ejecuta la búsqueda pgvector con `workspace_id` como primera cláusula del `WHERE`; ni la llave ni los embeddings se exponen al MCP.

### `debatidor_index_context`

Materializa hasta 50 mensajes persistidos de una Arena como recuerdos `MESSAGE`. Es una acción explícita porque genera escrituras derivadas y uso del proveedor de embeddings; no se oculta dentro de `debatidor_search_context`.

- requiere que la Arena pertenezca al workspace OAuth;
- usa la llave OpenAI BYOK del usuario;
- es no destructiva e idempotente por mensaje fuente;
- un mensaje sin cambios no vuelve a generar embeddings;
- un mensaje modificado actualiza la misma memoria derivada.

El uso de embeddings puede generar consumo/coste en la cuenta del proveedor configurada por el usuario.

Siguiente tool de P7:

- `debatidor_quick_debate`

## ChatGPT, Claude y Gemini

El core no contiene adapters específicos por proveedor. Todos deben consumir el mismo MCP remoto.

- ChatGPT: Developer Mode / MCP app; primer cliente de aceptación.
- Claude: Custom Connector remote MCP; segundo cliente de portabilidad previsto.
- Gemini y otros hosts: mismo endpoint cuando su producto soporte remote MCP compatible.

CIMD es la ruta principal de identificación OAuth. DCR se añadirá solo como fallback si un segundo cliente objetivo lo requiere.

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
- La búsqueda y la indexación de contexto permanecen workspace-scoped.
- Las llaves BYOK nunca cruzan hacia el MCP.
- Authorization codes y refresh tokens se almacenan hasheados; los refresh tokens rotan.
- No loguear tokens, códigos OAuth, API keys ni payloads sensibles completos.
- Las tools con efectos deben declarar annotations MCP acordes a su comportamiento y respetar autorización/confirmación del cliente.
