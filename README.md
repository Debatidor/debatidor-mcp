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
        debatidor-back
```

El endpoint remoto es el camino principal. `stdio` se conserva únicamente para clientes locales/IDE y debugging.

## Estado actual

Versión `0.2.0`:

- MCP TypeScript SDK v2, compatible con la revisión `2026-07-28`.
- Streamable HTTP en `/mcp`.
- servidor Docker listo para despliegue continuo en Easypanel;
- healthcheck HTTP en `/health` y `/healthz`;
- `debatidor_ping` siempre disponible y sin datos de usuario;
- `debatidor_get_lead_status` sigue disponible solo mediante el bridge privado/legacy con API key;
- el endpoint público **no habilita tools de datos de usuario hasta implementar OAuth 2.1 MCP**.

Esta separación permite desplegar y conectar el MCP remoto desde el inicio sin exponer una API key server-side ni datos de un workspace a usuarios anónimos.

## Desarrollo local

```bash
npm install
npm run check
npm test
npm run build
npm run dev:http
```

Por defecto escucha en:

```text
http://0.0.0.0:3002
```

Para desarrollo local puede usarse:

```bash
DEBATIDOR_MCP_HOST=127.0.0.1 \
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002 \
npm run dev:http
```

Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Selecciona **Streamable HTTP** y apunta a `http://127.0.0.1:3002/mcp`.

## Endpoint remoto de producción

Objetivo canónico:

```text
https://mcp.debatidor.com/mcp
```

El servicio se despliega como contenedor independiente detrás de Traefik/Easypanel. Variables mínimas:

```env
NODE_ENV=production
DEBATIDOR_MCP_HOST=0.0.0.0
DEBATIDOR_MCP_PORT=3002
DEBATIDOR_MCP_PUBLIC_BASE_URL=https://mcp.debatidor.com
DEBATIDOR_MCP_ALLOWED_HOSTS=mcp.debatidor.com
DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=false
```

No se necesita `DEBATIDOR_API_KEY` para el bootstrap público.

### Tool pública de bootstrap

`debatidor_ping` sirve para validar discovery, selección y tool calls reales desde un host remoto sin tocar datos privados.

### Tools autenticadas

`debatidor_get_lead_status` se registra únicamente cuando se habilita explícitamente:

```env
DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=true
DEBATIDOR_API_KEY=deb_live_xxx
```

Ese modo es **solo para redes locales/privadas y dogfooding temporal**. No debe habilitarse en `mcp.debatidor.com`.

La siguiente fase implementa OAuth 2.1 MCP (Protected Resource Metadata + Authorization Code + PKCE S256, priorizando CIMD y conservando DCR donde sea necesario). Después de eso las tools de Lead, Arena y memoria podrán exponerse de forma user-scoped en el endpoint remoto.

## ChatGPT, Claude y Gemini

El core no contiene adaptadores específicos por proveedor. Todos consumen el mismo endpoint MCP estándar:

```text
https://mcp.debatidor.com/mcp
```

- ChatGPT: conexión MCP/Plugin en Developer mode.
- Claude: Custom Connector por remote MCP.
- Gemini/otros hosts compatibles: custom MCP endpoint según disponibilidad del producto.

## stdio

Se mantiene para clientes locales:

```bash
DEBATIDOR_MCP_HOST=127.0.0.1 \
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002 \
npm run dev:stdio
```

## Seguridad

- El endpoint público no lleva una API key de usuario embebida.
- Las tools con datos de usuario permanecerán deshabilitadas hasta OAuth.
- Toda tool que acepte identificadores debe validar ownership/tenant en backend.
- Las futuras tools de escritura deben declarar annotations MCP correctas y respetar autorización/confirmación.
- No loguear tokens, API keys ni cuerpos sensibles completos.
