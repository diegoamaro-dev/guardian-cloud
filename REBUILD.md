# Guardian Cloud — Rebuild del scaffold móvil

**Estado:** `mobile/` tiene un scaffold roto (prebuild falla en
`withAndroidDangerousBaseMod: MainApplication does not exist`).
La decisión fue: **no parchear, rehacer base desde cero** con
`create-expo-app bare-minimum` y reinyectar nuestros deltas.

Este documento te dice **exactamente** qué ejecutar y qué validar.

---

## Qué necesitas (en tu máquina)

- Node 20+ (`node -v`)
- npm 10+ (`npm -v`)
- Acceso a `registry.npmjs.org` (sin VPN corporativa bloqueando)
- Para `expo run:android`: Android SDK + emulador o dispositivo con ADB

> Importante: el sandbox donde trabajamos en conjunto **no tiene acceso
> a npm registry**, por eso este rebuild tiene que correr en tu máquina.
> No es pereza, es un límite físico del entorno.

---

## Qué se ha preparado por ti

```
Guardián Cloud/
├── rebuild-mobile.sh      ← script one-shot
├── _deltas/               ← todo el código propio del proyecto
│   ├── app/               ← expo-router routes (login + authed home)
│   ├── src/               ← config/env.ts, auth/*, api/*
│   ├── .env.example
│   ├── app.config.ts      ← Guardian Cloud, package com.guardiancloud.app
│   ├── babel.config.js    ← reanimated/plugin último
│   ├── metro.config.js
│   ├── tsconfig.json      ← paths @/* → src/*
│   ├── eas.json
│   └── package.canonical.json   ← package.json actual, referencia de merge
└── mobile/                ← scaffold actual (roto) — se reemplazará
```

---

## Ejecución

### Paso A — dry run (valida sin tocar `mobile/`)

```bash
cd "Guardián Cloud"
bash rebuild-mobile.sh
```

El script:

1. Crea `_mobile-fresh/` con `create-expo-app@latest --template bare-minimum`.
2. Copia `app/`, `src/`, `.env.example`, `app.config.ts`, `babel.config.js`,
   `metro.config.js`, `tsconfig.json`, `eas.json` desde `_deltas/`.
3. Hace merge de `package.json` (scaffold baseline + 5 extras nuestros:
   `@supabase/supabase-js`, `@react-native-async-storage/async-storage`,
   `react-native-url-polyfill`, `zod`, `zustand` — más `expo-router`,
   `expo-dev-client`, etc.) y mantiene nuestros scripts.
4. `npm install` + `npx expo install --fix` (alinea versiones con la SDK).
5. `npx expo prebuild --clean` y **verifica** que exista
   `android/app/src/main/java/com/guardiancloud/app/MainApplication.{kt,java}`.

Si cualquiera de esos pasos falla, el script aborta **ruidosamente**
con un mensaje claro. **No reemplaza `mobile/`** hasta que tú lo digas.

### Paso B — promover (sustituir `mobile/`)

Sólo después de que el dry run pase:

```bash
bash rebuild-mobile.sh --promote
```

Esto:
- archiva el viejo como `mobile.old-YYYYMMDD-HHMMSS/` (por si quieres revisarlo)
- renombra `_mobile-fresh/` → `mobile/`

### Paso C — validación final en tu dispositivo

```bash
cd mobile
cp .env.example .env
# edita .env con tus valores reales de Supabase + API URL
npx expo prebuild --clean        # debe pasar limpio
npx expo run:android             # requiere emulador/dispositivo
```

---

## Criterios de aceptación (tus palabras)

- [ ] `npx expo prebuild --clean` termina sin errores
- [ ] `android/app/src/main/java/com/guardiancloud/app/MainApplication.kt` existe
- [ ] `npx expo run:android` compila y arranca

Si 1 o 2 fallan: el script se detiene y te lo dice exactamente. No avanzamos.

---

## Qué NO hace este rebuild

- No toca `backend/` (validado, off-limits)
- No añade SQLite, cola de uploads ni módulo de grabación
- No toca `docs/` ni `CLAUDE.md`
- No borra `mobile/` sin `--promote`

Siguiente ladrillo sólo cuando los 3 criterios pasen.

---

## Si algo falla

### `create-expo-app` falla (403 / network)
- Estás detrás de una VPN corporativa o proxy que bloquea npm.
- Prueba: `npm config get registry` — debe dar `https://registry.npmjs.org/`.
- Prueba: `curl -I https://registry.npmjs.org/create-expo-app` — 200 esperado.

### `prebuild --clean` sigue fallando con el mismo error
- Muy improbable en un scaffold fresco, pero si pasa: pásame el trace
  completo y el contenido de `_mobile-fresh/app.config.ts` tal como
  quedó tras el merge.

### `expo run:android` falla por toolchain (no por código)
- Eso es Android SDK / Java / emulador, no el scaffold.
- Confirma con `adb devices` y `sdkmanager --list`.
- Eso lo resolvemos por separado — no invalida este rebuild.

---

## Si tras promover quieres volver atrás

```bash
rm -rf mobile
mv mobile.old-YYYYMMDD-HHMMSS mobile
```

(Usa el timestamp real del directorio archivado.)
