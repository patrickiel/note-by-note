declare module '@echogarden/rubberband-wasm' {
  /** The subset of the Emscripten Module + Rubber Band C API
   * (rubberband-c.h) that the pitch worklet drives. Pointers are `number`
   * (offsets into the WASM heap). */
  export interface RubberBandModule {
    _rubberband_new(
      sampleRate: number,
      channels: number,
      options: number,
      initialTimeRatio: number,
      initialPitchScale: number,
    ): number;
    _rubberband_delete(state: number): void;
    _rubberband_reset(state: number): void;
    _rubberband_get_engine_version(state: number): number;
    _rubberband_set_pitch_scale(state: number, scale: number): void;
    _rubberband_set_formant_scale(state: number, scale: number): void;
    _rubberband_set_max_process_size(state: number, samples: number): void;
    _rubberband_get_latency(state: number): number;
    _rubberband_get_samples_required(state: number): number;
    _rubberband_process(
      state: number,
      input: number,
      samples: number,
      final: boolean,
    ): void;
    _rubberband_available(state: number): number;
    _rubberband_retrieve(
      state: number,
      output: number,
      samples: number,
    ): number;
    _malloc(bytes: number): number;
    _free(ptr: number): void;
    /** Live heap views — reassigned by the glue when the heap grows, so read
     * them fresh each block rather than caching across a process() call. */
    HEAPF32: Float32Array;
    HEAPU32: Uint32Array;
  }

  interface RubberBandModuleArg {
    wasmBinary?: ArrayBuffer | Uint8Array;
    instantiateWasm?: (
      imports: WebAssembly.Imports,
      success: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ) => object;
  }

  /** Emscripten MODULARIZE factory; resolves once the WASM is instantiated. */
  const Rubberband: (arg?: RubberBandModuleArg) => Promise<RubberBandModule>;
  export default Rubberband;
}
