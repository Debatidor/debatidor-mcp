# @debatidor/mcp

Servidor remoto oficial de **Model Context Protocol (MCP)** para Debatidor.

`debatidor-mcp` es un adaptador fino entre clientes MCP (ChatGPT, Claude, Gemini, IDEs y agentes compatibles) y `debatidor-back`. La autoridad de identidad, permisos, Arena, Lead, memoria y ejecución local permanece en el backend y en `debatidor-agent`.

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
          |         |
     Arena/PAL   /agent WS
                    |
             debatidor-agent
                    |
             proyecto / shell
```

El endpoint remoto es el camino principal. `stdio` se conserva únicamente para clientes locales/IDE y debugging.

## Estado actual

Versión `0.7.0`:

- MCP TypeScript SDK v2, compatible con la revisión `2026-07-28`;
- Streamable HTTP stateless en `/mcp`;
- Docker + healthcheck `/health` y `/healthz`;
- Protected Resource Metadata y OAuth 2.1 user-scoped;
- `debatidor_ping` para comprobación del servicio;
- `debatidor_get_lead_status` para Arenas `LEAD` del workspace autenticado;
- `debatidor_search_context` para búsqueda semántica read-only;
- `debatidor_index_context` para materializar explícitamente mensajes persistidos como memoria semántica;
- `debatidor_quick_debate` para inyectar una intervención y delegar la ejecución al runtime existente de Arena;
- `debatidor_agent_list`, `debatidor_agent_read`, `debatidor_agent_write` y `debatidor_agent_shell` para operar directamente el proyecto conectado por `debatidor-agent`, sin extensión DOM;
- bridge API-key legacy únicamente para dogfooding local/privado y mutuamente excluyente con OAuth.

El bootstrap `0.2.0` fue validado desde ChatGPT real; `0.3.0` añadió account linking user-scoped; `0.4.0` incorporó búsqueda semántica; `0.5.0` separó explícitamente indexación y lectura; `0.6.0` añadió la primera acción de Arena; `0.7.0` conecta clientes MCP directamente con las capacidades locales del agent.

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
ChatGPT
  -> Authorization Code + PKCE S256
  -> consentimiento Debatidor
  -> access token user-scoped
  -> Authorization: Bearer <token> en /mcp
  -> backend conserva userId + workspaceId
```

El access token se valida contra el backend antes de crear las tools user-scoped. El MCP nunca usa una API key global del contenedor para representar usuarios.

## Tools

### `debatidor_ping`

Comprueba versión/protocolo/reachability. No devuelve datos privados.

### `debatidor_get_lead_status`

Lee Arenas `LEAD` visibles en el workspace del principal OAuth. Con `debateId`, valida ownership antes de leer detalle.

### `debatidor_search_context`

Busca semánticamente recuerdos `MESSAGE` y `CONCLUSION` del workspace autenticado. La consulta es read-only; embeddings y BYOK permanecen en el backend.

### `debatidor_index_context`

Materializa mensajes persistidos como memoria semántica. Es una write explícita, no destructiva e idempotente por mensaje fuente; puede generar consumo del proveedor de embeddings configurado por el usuario.

### `debatidor_quick_debate`

Inyecta una intervención en una Arena **ya existente** y delega el trabajo al mismo runtime que usa web/CLI. Es una write no destructiva pero no idempotente; la respuesta confirma dispatch y los participantes completan asíncronamente.

## Proyecto conectado por `debatidor-agent`

La versión `0.7.0` añade un camino nativo para que el cliente MCP opere el proyecto del usuario sin convertir un chat web en un parser de bloques JSON:

```text
ChatGPT / Claude
      |
  tool MCP
      |
debatidor-mcp
      |
debatidor-back
      |
  /agent WS
      |
debatidor-agent
      |
filesystem / shell
      |
 resultado MCP
      |
mismo turno del cliente
```

Arranca el agent en el proyecto que quieres exponer:

```bash
cd mi-proyecto
debatidor connect --remote
```

Las tools de filesystem quedan confinadas al `cwd` del agent por `fs-guard` y el backend rechaza rutas absolutas o traversal (`..`).

### `debatidor_agent_list`

Lista un directorio relativo al proyecto. Read-only e idempotente.

### `debatidor_agent_read`

Lee un archivo relativo al proyecto. Read-only e idempotente.

### `debatidor_agent_write`

Crea o reemplaza un archivo relativo al proyecto. Es una acción destructiva en el sentido MCP porque modifica disco; repetir exactamente el mismo contenido es idempotente.

### `debatidor_agent_shell`

Ejecuta **un comando no interactivo** en el proyecto. Se marca destructiva y no idempotente porque un comando puede modificar archivos, Git o sistemas externos.

El runner headless **deniega shell por defecto**. Para habilitarla conscientemente:

```bash
debatidor connect --remote --shell-auto
```

Sin `--shell-auto`, `debatidor_agent_shell` devuelve `denied_headless_shell_disabled`; list/read/write siguen disponibles.

Si hay varios agents conectados bajo el mismo usuario/workspace, las tools aceptan `agentId` opcional. Si se omite, el backend usa el primer agent conectado del principal autenticado.

Los outputs grandes de archivo/shell se acotan antes de volver al contexto MCP para evitar inflar innecesariamente la conversación.

## ChatGPT, Claude y Gemini

El core no contiene adapters específicos por proveedor. Todos deben consumir el mismo MCP remoto.

- ChatGPT: app/Developer Mode MCP; primer cliente de aceptación.
- Claude: Custom Connector remote MCP; segundo cliente de portabilidad previsto.
- Gemini y otros hosts: mismo endpoint cuando su producto soporte remote MCP compatible.

La dirección nativa soportada es **cliente MCP → Debatidor → agent → resultado al mismo turno**. El servidor MCP no intenta empujar espontáneamente mensajes desde el CLI hacia una conversación web; para ese caso sigue existiendo la extensión DOM.

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
- El backend conserva autoridad de tenant/ownership y enruta resultados del agent por `userId + workspaceId`.
- Rutas de filesystem se validan en backend y nuevamente en `debatidor-agent`.
- Shell remota queda apagada salvo opt-in explícito `--shell-auto`.
- Las llaves BYOK nunca cruzan hacia el MCP.
- No loguear tokens, códigos OAuth, API keys ni payloads sensibles completos.
- Las tools con efectos declaran annotations MCP acordes a su comportamiento.
