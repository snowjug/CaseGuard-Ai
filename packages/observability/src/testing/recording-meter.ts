import {
  metrics,
  type Attributes,
  type BatchObservableCallback,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MetricOptions,
  type Observable,
  type ObservableCallback,
  type ObservableCounter,
  type ObservableGauge,
  type ObservableResult,
  type ObservableUpDownCounter,
  type UpDownCounter,
} from '@opentelemetry/api';

/** One `add` or `record` call made on a recorded instrument. */
export interface InstrumentCall {
  readonly kind: 'add' | 'record';
  readonly value: number;
  readonly attributes: Attributes | undefined;
}

/** An instrument created on the recording meter, with every call made on it. */
export interface CreatedInstrument {
  readonly type: 'counter' | 'gauge' | 'histogram' | 'observable_gauge';
  readonly name: string;
  readonly options: MetricOptions | undefined;
  readonly calls: InstrumentCall[];
  readonly callbacks: ObservableCallback[];
}

/** Recording OpenTelemetry meter: no SDK, just enough to assert what the metrics mirror forwards. */
export interface RecordingMeter {
  readonly meter: Meter;
  readonly instruments: CreatedInstrument[];
  find(name: string): CreatedInstrument | undefined;
  /** Runs every registered observable callback of `name` and returns what it observed. */
  observeAll(name: string): { value: number; attributes: Attributes | undefined }[];
}

/** Creates a meter that records the instruments created on it and every measurement taken. */
export function createRecordingMeter(): RecordingMeter {
  const instruments: CreatedInstrument[] = [];

  const record = (
    type: CreatedInstrument['type'],
    name: string,
    options: MetricOptions | undefined,
  ): CreatedInstrument => {
    const instrument: CreatedInstrument = { type, name, options, calls: [], callbacks: [] };
    instruments.push(instrument);
    return instrument;
  };

  const observable = (instrument: CreatedInstrument): Observable => ({
    addCallback(callback: ObservableCallback): void {
      instrument.callbacks.push(callback);
    },
    removeCallback(callback: ObservableCallback): void {
      const index = instrument.callbacks.indexOf(callback);
      if (index >= 0) instrument.callbacks.splice(index, 1);
    },
  });

  const meter: Meter = {
    createGauge(name, options): Gauge {
      const instrument = record('gauge', name, options);
      return {
        record: (value, attributes) =>
          void instrument.calls.push({ kind: 'record', value, attributes }),
      };
    },
    createHistogram(name, options): Histogram {
      const instrument = record('histogram', name, options);
      return {
        record: (value, attributes) =>
          void instrument.calls.push({ kind: 'record', value, attributes }),
      };
    },
    createCounter(name, options): Counter {
      const instrument = record('counter', name, options);
      return {
        add: (value, attributes) => void instrument.calls.push({ kind: 'add', value, attributes }),
      };
    },
    createUpDownCounter(): UpDownCounter {
      return { add: () => undefined };
    },
    createObservableGauge(name, options): ObservableGauge {
      return observable(record('observable_gauge', name, options));
    },
    createObservableCounter(): ObservableCounter {
      return observable(record('counter', 'unused', undefined));
    },
    createObservableUpDownCounter(): ObservableUpDownCounter {
      return observable(record('counter', 'unused', undefined));
    },
    addBatchObservableCallback(_callback: BatchObservableCallback): void {
      // The metrics mirror does not use batch callbacks.
    },
    removeBatchObservableCallback(_callback: BatchObservableCallback): void {
      // The metrics mirror does not use batch callbacks.
    },
  };

  return {
    meter,
    instruments,
    find: (name) => instruments.find((instrument) => instrument.name === name),
    observeAll(name) {
      const observed: { value: number; attributes: Attributes | undefined }[] = [];
      const result: ObservableResult = {
        observe: (value: number, attributes?: Attributes) => {
          observed.push({ value, attributes });
        },
      };
      for (const instrument of instruments.filter((item) => item.name === name)) {
        for (const callback of instrument.callbacks) void callback(result);
      }
      return observed;
    },
  };
}

/** Handle returned by `installRecordingMeter`. */
export interface InstalledMeter extends RecordingMeter {
  /** Removes the global meter provider. Call it in `afterEach`. */
  uninstall(): void;
}

/** Registers a recording meter as the global OpenTelemetry meter provider, standing in for the SDK. */
export function installRecordingMeter(): InstalledMeter {
  metrics.disable();
  const recording = createRecordingMeter();
  metrics.setGlobalMeterProvider({ getMeter: () => recording.meter });
  return { ...recording, uninstall: () => metrics.disable() };
}
