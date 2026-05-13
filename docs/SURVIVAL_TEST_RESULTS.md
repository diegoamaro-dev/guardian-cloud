# Guardian Cloud — Survival Test Results

## Cómo rellenar este documento

1. Cada tanda de validación abre una nueva **Sesión de validación** debajo de la sección 3. Copiar la plantilla, rellenar la cabecera, y dejar los bloques de tests no ejecutados marcados como `(no ejecutado)`.
2. Cada test ejecutado se rellena con los campos pedidos por su entrada en `SURVIVAL_TEST_MATRIX.md` (sección 5).
3. Anotar el **veredicto** mecánicamente desde los criterios PASS/FAIL del MATRIX. No suavizar.
4. Tras una tanda, escribir un párrafo corto en **Patrones detectados** identificando regresiones, sospechas, o invariantes en riesgo.

**Reglas no negociables**:
- `BLOCKED` solo para tests no ejecutables por causa externa (battery saver agresivo del OEM, device sin datos móviles para S06, etc.). Justificar siempre.
- `PASS` solo si todos los criterios PASS del MATRIX se cumplen. Cualquier duda → FAIL.
- Nunca editar resultados pasados. Si un test falla en una tanda posterior tras pasar en una anterior, eso es información — se registra como nueva entrada.

---

## 1. Plantilla — Sesión de validación

Copiar este bloque al inicio de cada tanda nueva.

```
## Sesión de validación — <fecha YYYY-MM-DD>

### Cabecera

- Fecha:
- Hora inicio:
- Hora fin:
- Tester:
- Device modelo:
- Android version:
- Fabricante / ROM:
- Build commit (SHA corto):
- Build tag (si aplica):
- Modo build: debug | release
- Red durante la tanda: WiFi | datos | mixto
- Battery saver: ON | OFF
- Battery optimization exemption concedida: SÍ | NO
- Destination configurado: Drive | NAS
- Cola al inicio: vacía | con N entradas (anotar cuáles)
- Observaciones generales antes de empezar:

### Bloques de tests

[Pegar el bloque de cada test del apartado 2 abajo, uno por test ejecutado]

### Patrones detectados en esta tanda

- (rellenar al final)

### Decisión post-tanda

- Promover a baseline / tag: SÍ | NO
- Rollback necesario: SÍ | NO (si SÍ, a qué tag)
- Acciones de seguimiento:
```

---

## 2. Plantillas — Bloques por test

Una plantilla por test. Copiar la que corresponda dentro del bloque "Bloques de tests" de la sesión.

### SURVIVAL_S01 — Pantalla apagada 15 min

```
#### SURVIVAL_S01
- chunks_emitidos:
- chunks_subidos:
- duración_real_grabación_min:
- gap_máximo_entre_emisiones_s:
- recovery_ok: N/A
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave: <snippet de los logs más relevantes>
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S02 — App en background 15 min

```
#### SURVIVAL_S02
- chunks_emitidos:
- chunks_subidos:
- pantalla_durante_test: encendida | apagada
- gap_máximo_entre_emisiones_s:
- dirty_state_detectado_al_volver: SÍ | NO
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S03 — Swipe-close durante grabación

```
#### SURVIVAL_S03
- chunks_emitidos_antes_swipe:
- chunks_subidos_al_final:
- recovery_ok: SÍ | NO
- segundos_hasta_drain_completo:
- GC_BOOT_DIRTY_STATE_DETECTED visto: SÍ | NO
- GC_BOOT_DIRTY_STATE_RECORDER_STOP_FAILED visto: SÍ | NO (aceptable)
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S04 — Swipe-close durante upload pendiente

```
#### SURVIVAL_S04
- chunks_pendientes_al_swipe:
- chunks_subidos_tras_reopen:
- segundos_hasta_drain_completo_tras_reopen:
- recovery_ok: SÍ | NO
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S05 — Pérdida de red 5 min

```
#### SURVIVAL_S05
- chunks_emitidos_durante_modo_avión:
- chunks_subidos_total:
- segundos_hasta_reanudación_drain:
- errores_red_observados (count):
- chunker_se_detuvo_sin_red: SÍ | NO
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S06 — Cambio WiFi → datos móviles

```
#### SURVIVAL_S06
- chunks_emitidos:
- chunks_subidos:
- errores_red_observados (count):
- duración_test_min:
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S07 — Modo ahorro batería activo

```
#### SURVIVAL_S07
- fabricante_y_rom:
- chunks_emitidos:
- chunks_subidos:
- duración_real_antes_de_matar (si aplica, en min):
- doze_intervino_visiblemente: SÍ | NO | DESCONOCIDO
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones (anotar si el OEM es notoriamente agresivo: Xiaomi/MIUI, Huawei/EMUI, Samsung pre-modern, OnePlus/OxygenOS, etc.):
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S08 — Force Stop con cola pendiente

```
#### SURVIVAL_S08
- chunks_pendientes_al_force_stop:
- chunks_subidos_tras_recovery:
- GC_BOOT_STUCK_UPLOAD_RESET visto: SÍ | NO
- segundos_hasta_drain_completo:
- recovery_ok: SÍ | NO
- export_ok: SÍ | NO
- reproducible: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S09 — Grabar mientras otra sube

```
#### SURVIVAL_S09
- chunks_emitidos_A:
- chunks_subidos_A:
- chunks_emitidos_B:
- chunks_subidos_B:
- delay_inicio_B_observado_s:
- "REC START ignored" visto al arrancar B: SÍ | NO (NO = PASS)
- chunks_cruzados (algún A en B o viceversa): SÍ | NO (SÍ = FAIL)
- export_A_ok: SÍ | NO
- export_B_ok: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

### SURVIVAL_S10 — Export pre/post completion

```
#### SURVIVAL_S10
- chunks_subidos_al_primer_export:
- chunks_subidos_al_segundo_export:
- verdor_primero (texto literal mostrado en UI):
- verdor_segundo (texto literal mostrado en UI):
- cause_primero (de GC_EXPORT_DIAG_VERDICT):
- cause_segundo (de GC_EXPORT_DIAG_VERDICT):
- reproducible_primero: SÍ | NO
- reproducible_segundo: SÍ | NO
- archivo_segundo_mas_largo_o_igual_que_primero: SÍ | NO
- logs_clave:
- observaciones:
- veredicto: PASS | FAIL | BLOCKED
```

---

## 3. Sesiones de validación registradas

> Las sesiones reales se añaden bajo este encabezado, una debajo de otra, sin borrar las anteriores. La más reciente arriba.

(Sin sesiones registradas todavía. Añadir la primera tanda aquí copiando la plantilla de la sección 1.)

---

## 4. Patrones acumulados (vista cruzada entre tandas)

> Esta sección se mantiene a mano. Tras varias tandas, anotar aquí tendencias que afecten al producto:
> - tests que fallan repetidamente en un mismo OEM
> - regresiones reintroducidas tras un cambio concreto
> - métricas de tiempo de drain post-stop por device
> - cualquier patrón que justifique abrir un docs/KNOWN_LIMITS.md adicional

(Vacío hasta tener al menos dos tandas.)
