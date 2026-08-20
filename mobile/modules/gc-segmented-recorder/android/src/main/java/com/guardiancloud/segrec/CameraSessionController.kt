package com.guardiancloud.segrec

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface

/**
 * SPIKE — P2 early gate. Sole owner of the camera session.
 *
 * ONE `CameraCaptureSession` with TWO output surfaces: preview and the video
 * encoder's input surface. The camera is never shared with another pipeline —
 * `expo-camera` mounts nothing while this module is active.
 *
 * Also the source of `CaptureResult.SENSOR_TIMESTAMP`, which contract 2
 * requires logging alongside the encoder PTS and the system clock so their
 * relationship is characterised rather than assumed.
 */
class CameraSessionController(
  private val context: Context,
  private val characterisation: ClockCharacterisation,
  private val onError: (String, String) -> Unit,
) {
  private val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
  private var device: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private val thread = HandlerThread("gc-segrec-camera").apply { start() }
  private val handler = Handler(thread.looper)

  var timestampSource: Int = CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN
    private set

  /** Resolve the back camera and read its timestamp source before opening. */
  fun resolveCamera(): String? {
    return try {
      val id = manager.cameraIdList.firstOrNull { camId ->
        val ch = manager.getCameraCharacteristics(camId)
        ch.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
      } ?: manager.cameraIdList.firstOrNull()

      if (id != null) {
        val ch = manager.getCameraCharacteristics(id)
        timestampSource =
          ch.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
            ?: CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN
        Log.i(TAG, "GC_P2_GATE camera_id=$id timestamp_source=$timestampSource")
      }
      id
    } catch (t: Throwable) {
      onError(ErrorCode.CAMERA_OPEN_FAILED, "resolveCamera failed: ${t.message}")
      null
    }
  }

  @SuppressLint("MissingPermission")
  fun open(cameraId: String, previewSurface: Surface, encoderSurface: Surface, onReady: () -> Unit) {
    try {
      manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
          device = camera
          createSession(camera, previewSurface, encoderSurface, onReady)
        }

        override fun onDisconnected(camera: CameraDevice) {
          onError(ErrorCode.CAMERA_LOST, "camera disconnected")
          camera.close()
          device = null
        }

        override fun onError(camera: CameraDevice, error: Int) {
          onError(ErrorCode.CAMERA_OPEN_FAILED, "camera error code=$error")
          camera.close()
          device = null
        }
      }, handler)
    } catch (t: Throwable) {
      onError(ErrorCode.CAMERA_OPEN_FAILED, "openCamera threw: ${t.message}")
    }
  }

  @Suppress("DEPRECATION")
  private fun createSession(
    camera: CameraDevice,
    previewSurface: Surface,
    encoderSurface: Surface,
    onReady: () -> Unit,
  ) {
    val surfaces = listOf(previewSurface, encoderSurface)
    try {
      camera.createCaptureSession(surfaces, object : CameraCaptureSession.StateCallback() {
        override fun onConfigured(configured: CameraCaptureSession) {
          session = configured
          val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
            surfaces.forEach { addTarget(it) }
          }.build()
          configured.setRepeatingRequest(request, captureCallback, handler)
          Log.i(TAG, "GC_P2_GATE camera_session_configured surfaces=${surfaces.size}")
          onReady()
        }

        override fun onConfigureFailed(configured: CameraCaptureSession) {
          onError(ErrorCode.CAMERA_OPEN_FAILED, "capture session configuration failed")
        }
      }, handler)
    } catch (t: Throwable) {
      onError(ErrorCode.CAMERA_OPEN_FAILED, "createCaptureSession threw: ${t.message}")
    }
  }

  /**
   * Feeds `SENSOR_TIMESTAMP` into its OWN series (contract 2).
   *
   * It is not paired with an encoder buffer here. Pairing by arrival instant
   * would be temporal proximity, not correspondence — the correlation happens
   * in [ClockCharacterisation.report] by matching VALUES, and reports the
   * match rate rather than assuming one.
   */
  private val captureCallback = object : CameraCaptureSession.CaptureCallback() {
    override fun onCaptureCompleted(
      s: CameraCaptureSession,
      request: CaptureRequest,
      result: TotalCaptureResult,
    ) {
      result.get(CaptureResult.SENSOR_TIMESTAMP)?.let {
        characterisation.onSensorTimestamp(it)
      }
    }
  }

  fun close() {
    try { session?.stopRepeating() } catch (_: Throwable) { }
    try { session?.close() } catch (_: Throwable) { }
    try { device?.close() } catch (_: Throwable) { }
    session = null
    device = null
    thread.quitSafely()
  }

  companion object {
    private const val TAG = "GCSegRec"
  }
}
