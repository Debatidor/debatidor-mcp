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

Versión `0.7.3`:

- MCP TypeScript SDK v2, revisión objetivo `2026-07-28`;
- Streamable HTTP stateless en `/mcp`;
- Docker + `/health` y `/healthz`;
- Protected Resource Metadata en `/.well-known/oauth-protected-resource`;
- OAuth requerido en producción;
- ChatGPT y Claude validados como clientes reales contra el mismo endpoint;
- `debatidor_ping` y `debatidor_get_lead_status`;
- `debatidor_search_context` / `debatidor_index_context` sobre Context Service, la memoria propia de Debatidor;
- `debatidor_quick_debate` para inyectar una intervención en una Arena existente;
- `debatidor_agent_list/read/write/shell` para operar un proyecto conectado por `debatidor-agent` sin DOM;
- bridge API-key legacy solo para dogfooding local/privado.

Para `quick_debate` en modo web, usar la extensión 0.4.7 o posterior, vincular la sala y habilitar la pestaña del proveedor. Indicar `connectionId` para dirigirse a un solo participante; si se omite, todos los participantes web configurados deben estar listos. La herramienta informa si el navegador no está configurado, no está listo o no pudo recibir el turno. `accepted: true` confirma el despacho; comprobar la respuesta del participante en la Arena y recargarla para verificar su persistencia. No reintentar automáticamente después de un fallo de despacho.

Las nuevas instrucciones de esta herramienta aparecen como **MCP** en la transcripción. El cliente externo no se identifica como ChatGPT o Claude a partir de su texto; su conversación y confirmación fuera de la llamada no se copian a la Arena. Los turnos web de `quick_debate` no habilitan herramientas de archivos o shell; las sesiones del agente y las herramientas MCP `debatidor_agent_*` mantienen sus propios permisos.

La memoria se consulta mediante Context Service y funciona sin claves ni créditos de proveedores externos. Esta versión identifica la recuperación textual y comunica que el motor semántico está indisponible. Cada resultado incluye relevancia y procedencia; no presenta el ranking textual como similitud semántica. Requiere el backend P11 con `/context/search` y `/context/index-debate`.

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

Búsqueda read-only del contexto del workspace autenticado, opcionalmente limitada a una Arena. Conserva los inputs `query` (requerido), `debateId`, `kinds` y `limit`; no requiere ejecutar previamente la tool de indexación.

`kinds` acepta `MESSAGE`, `CONCLUSION`, `FACT`, `DECISION` y `SUMMARY`. Para mantener las consultas de clientes anteriores, si se omite o se envía `[]`, el MCP manda explícitamente `['MESSAGE', 'CONCLUSION']` al backend. Los tipos nuevos se incluyen solo al solicitarlos: por ejemplo, `kinds: ['FACT', 'DECISION', 'SUMMARY']`; para los cinco tipos, envía los cinco valores. Los clientes que pidan tipos nuevos deben aceptar esos valores en los resultados.

El MCP consume `POST /context/search`, el mismo Context Service del Hub. Conserva `query`, `hitCount`, `hits` y los campos previos de cada hit. Añade:

- `score`: relevancia textual o híbrida, sin prometer una escala de similitud;
- `retrievalMethod: "text" | "hybrid"` y `semanticSimilarity: number | null`;
- `sourceId` y `provenance`: `messageId` (nullable), `sourceRevision` (entero), `originType` y `originId`;
- `retrieval` (método y disponibilidad semántica) y `partial` a nivel de respuesta; el contrato anterior `text` / `unavailable` sigue siendo válido.

El campo requerido heredado `similarity` se mantiene numérico: toma `semanticSimilarity` cuando existe una coincidencia semántica y `0` cuando es solo textual. Ese cero textual es un marcador de compatibilidad, **no una similitud coseno medida**. El texto de la tool distingue `score` de la similitud coseno y comunica método, disponibilidad semántica y resultados parciales.

El consumidor acepta también el contrato híbrido sin cambiar endpoints ni inputs: `retrieval.method` y `retrievalMethod` pueden ser `text` o `hybrid`; `semanticStatus` acepta `unavailable`, `warming`, `busy`, `ready` o `partial`. `score` es relevancia FTS o fusión RRF, nunca coseno; `semanticSimilarity` es `null` o un coseno entre -1 y 1. El envelope puede incluir `retrieval.modelKey` y `reason` (`disabled`, `model_unavailable`, `query_over_budget`, `index_pending`, `quota`, `timeout`, `inference_failed`).

Cada hit semántico incluye `provenance.chunk: { id, chunkerVersion, startUtf16, endUtf16 }`. Las posiciones son índices UTF-16 sobre el texto original, con fin excluido; `content` es la cita exacta y su longitud coincide con el rango. `hit.id` sigue identificando la entrada original. Los hits puramente textuales conservan `semanticSimilarity: null` y no tienen chunk, incluso dentro de una respuesta híbrida. Los consumidores deben desplegarse antes de activar el contrato híbrido del backend.

Una respuesta malformada del backend devuelve `isError: true`; nunca se transforma en una lista vacía ni provoca una indexación o un fallback automático al backend anterior. Una búsqueda válida sin coincidencias devuelve `hits: []` junto con sus metadatos. El endpoint backend heredado `/vector-memory/search` conserva su array para otros consumidores; este MCP utiliza el envelope canónico de Context Service.

### `debatidor_index_context`

Mantenimiento explícito para materializar o refrescar contexto desde mensajes persistidos de una Arena. Es una escritura no destructiva e idempotente por fuente; no es un requisito de la búsqueda normal y no consume una clave externa del usuario.

Usa `POST /context/index-debate`, alias del mantenimiento heredado `/vector-memory/index-debate`. Conserva `debateId` requerido, `limit` opcional (máximo 50) y el resultado `{ debateId, scanned, indexed, unchanged, empty, cappedAt }`. `indexed` cuenta materialización textual completada; `unchanged` cuenta fuentes cuya revisión permanece intacta. No indica embeddings creados ni trabajo meramente encolado.

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
