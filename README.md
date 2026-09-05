# @debatidor/mcp

Servidor remoto oficial de **Model Context Protocol (MCP)** para Debatidor.

`debatidor-mcp` es un adaptador fino entre clientes MCP (ChatGPT, Claude, IDEs y otros hosts compatibles) y `debatidor-back`. La autoridad de identidad, permisos, Arena, Lead, memoria y datos permanece en el backend; filesystem/shell se ejecutan exclusivamente en `debatidor-agent`.

## Arquitectura

```text
ChatGPT / Claude / IDEs
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

El endpoint remoto es el camino de producto. `stdio` se conserva para clientes locales/IDE y debugging.

## Estado actual

Versión `0.7.1`:

- MCP TypeScript SDK v2, revisión objetivo `2026-07-28`;
- Streamable HTTP stateless en `/mcp`;
- Docker + `/health` y `/healthz`;
- Protected Resource Metadata en `/.well-known/oauth-protected-resource`;
- OAuth requerido en producción;
- ChatGPT y Claude validados como clientes reales contra el mismo endpoint;
- `debatidor_ping` y `debatidor_get_lead_status`;
- `debatidor_search_context` / `debatidor_index_context` como superficie de memoria heredada;
- `debatidor_quick_debate` para inyectar una intervención en una Arena existente;
- `debatidor_agent_list/read/write/shell` para operar un proyecto conectado por `debatidor-agent` sin DOM;
- bridge API-key legacy solo para dogfooding local/privado.

Para `quick_debate` en modo web, usar la extensión 0.4.6 o posterior, vincular la sala y habilitar la pestaña del proveedor. La herramienta informa si el navegador no está configurado, no está listo o no pudo recibir el turno. `accepted: true` confirma el despacho; comprobar la respuesta del participante en la Arena y recargarla para verificar su persistencia. No reintentar automáticamente después de un fallo de despacho.

La implementación actual de vector-memory todavía usa OpenAI BYOK para embeddings. **Eso es deuda transitoria, no el contrato futuro del producto.** ADR-0011/P11 fijan que historial/contexto/memoria serán first-party Debatidor y no dependerán de créditos externos del usuario. P7 únicamente transporta las tools.

## Desarrollo local

```bash
npm install
npm run check
npm test
npm run build
```

Servidor HTTP local sin OAuth:

```bash
DEBATIDOR_MCP_HOST=127.0.0.1 \
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002 \
DEBATIDOR_MCP_OAUTH_ENABLED=false \
npm run dev:http
```

Inspector oficial:

```bash
npx @modelcontextprotocol/inspector@latest
```

El CI levanta el build local y usa el Inspector para ejecutar `tools/list` y `debatidor_ping`.

## Producción

Endpoint MCP:

```text
https://mcp.debatidor.com/mcp
```

Probe público:

```text
https://mcp.debatidor.com/health
```

En producción `/mcp` está protegido por OAuth. No debe describirse `debatidor_ping` como una ruta HTTP pública; la reachability sin autenticación vive en `/health`.

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

cliente MCP
  -> Authorization Code + PKCE S256
  -> CIMD client identity
  -> consentimiento Debatidor
  -> access token user-scoped
  -> Authorization: Bearer <token> en /mcp
```

El bearer se valida contra el backend antes de crear las tools user-scoped. El MCP nunca representa a todos los usuarios con una API key global del contenedor.

## Tools

### `debatidor_ping`

Comprueba versión/protocolo/reachability dentro de una sesión MCP válida. No devuelve datos privados.

### `debatidor_get_lead_status`

Lee Arenas `LEAD` visibles en el workspace del principal OAuth. Con `debateId`, valida ownership antes de leer detalle.

### `debatidor_search_context`

Búsqueda read-only sobre la memoria del workspace. El contrato MCP no conoce ni debe conocer el proveedor de embeddings.

**Estado transitorio 0.7.x:** el backend actual todavía genera embeddings con OpenAI BYOK. P11 reemplazará ese acoplamiento por memoria/retrieval first-party administrado por Debatidor.

### `debatidor_index_context`

Reindexa/materializa mensajes persistidos de una Arena. Es una write no destructiva e idempotente por fuente.

**Estado transitorio 0.7.x:** el backend actual todavía usa OpenAI BYOK para los embeddings. En P11 esta tool queda como mantenimiento/backfill; el flujo normal de memoria será automático y first-party.

### `debatidor_quick_debate`

Inyecta una intervención en una Arena **ya existente** y reutiliza el runtime real de Arena. No crea un segundo orquestador dentro del MCP.

Inputs:

- `debateId`: Arena del workspace autenticado;
- `prompt`: intervención a persistir/despachar;
- `mode`: `web`, `api` o `both`;
- `connectionId`: opcional para dirigir la parte DOM.

Es no idempotente: repetirla genera otra intervención. `mode=api` puede consumir proveedores BYOK; `mode=web` puede usar un participante web conectado por la extensión sin consumir una API BYOK.

El backend tiene cobertura de integración del camino:

```text
quickDebate
  -> agent.say
  -> persistHumanMessage
  -> Arena/PAL runtime
  -> persistCompletedTurn
```

La aceptación final de P7 todavía exige un `quick_debate` desde un cliente MCP real y confirmar el turno persistido.

## Proyecto conectado por `debatidor-agent`

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
mismo turno
```

Arranca el agent desde la raíz del proyecto:

```bash
cd mi-proyecto
debatidor connect --remote
```

Las rutas quedan confinadas al `cwd` en backend y agent.

### `debatidor_agent_list`

Lista un directorio relativo. Read-only e idempotente.

### `debatidor_agent_read`

Lee un archivo relativo. Read-only e idempotente.

### `debatidor_agent_write`

Crea/reemplaza un archivo relativo. Modifica disco y se marca destructiva.

### `debatidor_agent_shell`

Ejecuta un comando no interactivo. Shell headless está **apagado por defecto**.

Para habilitarlo conscientemente:

```bash
debatidor connect --remote --shell-auto
```

Sin `--shell-auto`, devuelve `denied_headless_shell_disabled`.

Las tools aceptan `agentId` opcional. La evolución P9/ADR-0012 exige que targets explícitos fallen cerrado si el agent no está conectado y que reconexiones reemplacen registros stale.

## Clientes validados

### ChatGPT

Primer cliente de aceptación. Validado con OAuth, lectura de Arena y control de repo por `MCP → backend → agent` incluyendo filesystem, shell, Git y una tarea de coding real.

### Claude

Segundo cliente real de portabilidad. Validado contra **el mismo endpoint MCP**, con OAuth/CIMD y operaciones `list/read/shell` sobre el repo conectado.

No existe un adapter MCP específico para Anthropic.

### Gemini y otros hosts

Deben consumir el mismo endpoint cuando el host ofrezca remote MCP compatible. Gemini/DCR es compatibilidad posterior y no bloquea P7 porque la portabilidad ya fue demostrada con Claude.

## Operación y smoke tests

### CI local del protocolo

Cada PR/push ejecuta typecheck/tests/build, levanta el servidor y usa el **MCP Inspector oficial** para:

```text
tools/list
  -> descubre debatidor_ping

tools/call debatidor_ping
  -> respuesta válida
```

### Remote production smoke

`.github/workflows/remote-smoke.yml` se ejecuta en cambios relevantes, manualmente y de forma programada. Verifica sin credenciales de usuario:

- `/health` devuelve servicio/version/OAuth esperados;
- Protected Resource Metadata apunta al Authorization Server correcto;
- `/mcp` sin bearer devuelve `401` + `WWW-Authenticate` con `resource_metadata` correcto.

No almacena tokens humanos ni automatiza consentimiento OAuth.

## Dirección del protocolo

La dirección nativa es:

```text
cliente MCP -> Debatidor -> agent/Arena -> resultado al mismo cliente
```

Un servidor MCP no se usa para despertar espontáneamente una conversación web a partir de un mensaje iniciado por el CLI. Para `CLI -> chat web` sigue existiendo la extensión DOM o un runtime de modelo controlado por API.

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
- El MCP valida bearer antes de exponer datos/tools user-scoped.
- Backend conserva autoridad de audience/resource/scope/tenant/ownership.
- Quick debate, memoria y agent execution permanecen workspace-scoped.
- `agent.file_result` solo resuelve tareas del mismo `userId + workspaceId`.
- Filesystem se valida en backend y agent, incluyendo rutas Unix/Windows.
- Shell remota requiere `--shell-auto`.
- Las llaves BYOK nunca cruzan hacia el MCP.
- Authorization codes y refresh tokens se almacenan hasheados; refresh rota.
- No loguear tokens, códigos OAuth, API keys ni payloads sensibles completos.
- Las annotations MCP deben reflejar side effects reales.

## P7 — gates restantes

La infraestructura/protocolo están verificados. Antes de declarar P7 cerrado faltan únicamente dos pruebas de producto con identidades reales:

1. ChatGPT autenticado ejecuta `debatidor_quick_debate` y se confirma un `turn.completed` persistido.
2. Dos users/workspaces distintos demuestran aislamiento efectivo entre debates/agents.

La memoria first-party se implementa en P11 y no es un gate de cierre de P7.
