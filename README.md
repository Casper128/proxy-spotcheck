# SpotCheck — Proxy del inspector

Servicio Node independiente para revisar sitios públicos sin instalar el snippet. Incluye el inspector en `public/spotcheck-inspector.js`; no necesita el repositorio del frontend ni el backend.

## SiteGround

- Repositorio `Casper128/proxy-spotcheck`, rama `main`.
- Node 22; instalación `npm ci` (o `npm install` según el panel).
- Build `npm run build` (si el formulario incluye `npm`, escribe `run build`).
- Inicio `npm start`. El servidor escucha en `0.0.0.0` y usa el `PORT` asignado por el alojamiento; no fuerces un puerto público.
- El build solo comprueba sintaxis: este proyecto no necesita compilar assets.

Variables del proyecto, sustituyendo dominios por las direcciones públicas reales sin barra final:

```dotenv
APP_ORIGIN=https://DOMINIO_REAL_DEL_FRONTEND
PROXY_ORIGIN=https://DOMINIO_REAL_DEL_PROXY
```

El frontend y el proxy deben tener orígenes diferentes. No configures DATABASE_URL, credenciales de Google ni secretos de sesión aquí. Las variables deben configurarse en el panel; el servidor no carga archivos `.env` automáticamente.

En el frontend configura `NEXT_PUBLIC_PROXY_ORIGIN` con la misma URL del proxy y reconstruye. En el backend configura `PROXY_ORIGIN` con esa URL para que `/api/config` la anuncie.

`GET /health` debe devolver JSON de salud. El proceso necesita salida HTTP/HTTPS y DNS hacia sitios públicos. Mantiene validación de destinos, protección SSRF, restricciones de puertos y límites de recursos. Algunos sitios con autenticación, protección anti-bot o navegaciones dinámicas requieren integración mediante snippet.

## Docker

`docker build -t spotcheck-proxy .` y configura las variables al ejecutar. El contenedor no necesita base de datos ni volumen persistente.

## Sincronización

El inspector incluido es una copia del publicado por el frontend. Cuando cambie el protocolo o el inspector, sincroniza este archivo con `frontend/public/spotcheck-inspector.js` del repositorio SpotCheck.
