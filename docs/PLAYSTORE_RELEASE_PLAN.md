# Guardian Cloud — Plan de release en Play Store

**Estado: NO INICIADO.** Este documento describe lo que falta, no lo que existe.

---

## 1. Situación real hoy (2026-07-30)

| | |
|---|---|
| Baseline técnica | [`v0.3.0-rc.1`](./releases/v0.3.0-rc.1.md) — APK `preview`, un dispositivo propio |
| AAB de producción | **nunca construido** |
| Ficha en Play Console | **no existe** |
| Closed Testing | **no iniciado** |
| Usuarios externos | **ninguno** |
| Veredicto de auditoría | **`NO APTO`** (2026-07-28), vigente |

**No se puede publicar.** No por falta de trámites, sino porque el producto no
cumple todavía su promesa central en modo vídeo.

---

## 2. Los tres artefactos, que no deben confundirse

| Artefacto | Comando | Formato | Para qué |
|---|---|---|---|
| **Build local** | `npx expo run:android` | APK debug/release | iterar en desarrollo |
| **EAS `preview`** | `eas build --profile preview` | APK, `internal` | candidatas, validación en dispositivo propio |
| **EAS `production`** | `eas build --profile production` | **AAB** | Play Store |

La baseline `v0.3.0-rc.1` es del segundo tipo. Un APK `preview` **no es
publicable**: Play Store exige AAB, y el perfil `production` de `eas.json` tiene
`autoIncrement: true` y entorno `production`, que hoy **no tiene ninguna variable
de entorno configurada**.

---

## 3. Bloqueos por orden de gravedad

### 3.1 Bloqueos de producto — no se resuelven con trámites

1. ~~**El vídeo no saca evidencia del dispositivo durante la grabación**
   (GC-AUD-001).~~ **RESUELTO.** La ruta nativa segmentada sube durante la
   captura y quedó demostrado en hardware el 20/08 — primera subida confirmada a
   `+14,619 s` frente a un PARAR en `+75,514 s`. La **fase D** está cumplida.
   Ya **no** es un bloqueo de publicación.
2. **No existe `capture_end_reason`.** El sistema no puede distinguir una
   captura terminada limpiamente de una truncada. Fases **E-1/E-2/E-3**.
3. **Recovery I5c** (automático tras reinicio del dispositivo, sin abrir la app)
   no implementado.
4. **Cifrado local** no implementado, pese a aparecer en documentación histórica.
5. **Export final `.mp4`** no implementado ni validado: una sesión de vídeo
   sube fragmentos, pero no existe reconstrucción utilizable para el usuario.
6. **Un solo dispositivo validado** — OnePlus A6000 / Android 11 / API 30. Sin
   cobertura multi-dispositivo ni Android 13+.

### 3.2 Bloqueos técnicos

5. **Versionado sin resolver.** La app declara `0.1.0` / `versionCode 1`. Play
   Store exige `versionCode` monótono creciente y una versión coherente. Además
   `appVersionSource: "remote"` está declarado sin versiones remotas.
6. **TypeScript no verde**: 12 errores heredados.
7. **Sin CI.** Ningún resultado de tests es reproducible de forma independiente.
8. **Entorno `production` de EAS vacío**: sin las tres `EXPO_PUBLIC_*`, un AAB de
   producción arrancaría y moriría igual que ocurrió con la build `528f720e`.

### 3.3 Bloqueos de cobertura

9. **Rama Android 13+ sin probar.** `POST_NOTIFICATIONS` es SDK 33+ y toda la
   validación se hizo en Android 11. Play Store exige `targetSdk` alto y la
   mayoría del parque está en 13+.
10. **Un solo dispositivo, un solo nivel de API.** Sin matriz de dispositivos.
11. **Sin usuarios externos.**

---

## 4. Secuencia mínima hasta publicar

Cada paso exige que el anterior esté cerrado. No se adelantan trámites.

1. **Cerrar fase D** — el vídeo sube durante la grabación. Sin esto, publicar es
   incorrecto por producto, no por proceso.
2. **Cerrar fases E-1/E-2/E-3** — `capture_end_reason` y semántica honesta de
   captura interrumpida.
3. **Fase F** — Android, OAuth, firma, seguridad de release.
4. **Resolver el versionado** y dejar `versionCode` gestionado.
5. **TypeScript en cero errores.**
6. **Montar CI** que ejecute la suite en cada push.
7. **Configurar el entorno `production` de EAS** con las tres `EXPO_PUBLIC_*`.
8. **Fase G** — validación física en build release con Metro apagado, sobre una
   matriz de dispositivos que incluya **Android 13, 14 y 15**.
9. **Construir el AAB de producción** y verificar su arranque real.
10. **Play Console**: ficha, Data Safety, política de privacidad publicada.
11. **Closed Testing**: 12 testers mínimo, 14 días sin regresiones.
12. **Fase H** — reconciliación documental completa con evidencia física.
13. **Retirar el veredicto `NO APTO`** — sólo cuando haya evidencia, no antes.
14. **Etiquetar `v0.3.0`** final y publicar.

---

## 5. Reglas de la ficha

Ya recogidas en [`RELEASE_CHECKLIST_v0.3.md`](./RELEASE_CHECKLIST_v0.3.md) §7.
Resumen: prohibido «seguridad total», «garantía legal», «protección absoluta»,
«indetectable» y «automático en background» sin acción del usuario.

Mientras el vídeo no proteja durante la grabación, la ficha **no puede afirmar**
que la evidencia sobrevive a la pérdida del dispositivo sin acotar el modo.

---

## 6. Permisos y Data Safety

`drive.file` únicamente — la app sólo ve los ficheros que ella crea. El contenido
de las grabaciones **no** se almacena en servidor propio: va al Drive del
usuario. Ese es el argumento central de privacidad y debe declararse con
exactitud en el formulario.

Atención a Android 15 y a los tipos de foreground service: `microphone` para
audio, `camera` + `microphone` para vídeo con audio, `dataSync` o mecanismo
permitido para la subida — y la prohibición de arrancar `camera`, `microphone` o
`dataSync` desde `BOOT_COMPLETED`.
