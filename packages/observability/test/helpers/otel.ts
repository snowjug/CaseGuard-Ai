import type {
  Attributes,
  Counter,
  Gauge,
  Histogram,
  Meter,
  MetricOptions,
  ObservableCallback,
  ObservableCounter,
  ObservableGauge,
  ObservableResult,
  ObservableUpDownCounter,
  UpDownCounter,
  BatchObservableCallback,
  Observable,
} from '@opentelemetry/api';

export interface InstrumentCall {
  readonly kind: 'add' | 'record';
  readonly value: number;
  readonly attributes: Attributes | undefined;
}

export interface CreatedInstrument {
  readonly type: 'counter' | 'gauge' | 'histogram' | 'observable_gauge';
  readonly name: string;
  readonly options: MetricOptions | undefined;
  readonly calls: InstrumentCall[];
  readonly callbacks: ObservableCallback[];
}

/** Recording OpenTelemetry meter: no SDK, just enough to assert what the mirror forwards. */
export function createFakeMeter() {
  const instruments: CreatedInstrument[] = [];

  const record = (
    type: CreatedInstrument['type'],
    name: string,
    options: MetricOptions | undefined,
  ) => {
    const instrument: CreatedInstrument = { type, name, options, calls: [], callbacks: [] };
    instruments.push(instrument);
    return instrument;
  };

  const noopObservable = (instrument: CreatedInstrument): Observable => ({
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
      return noopObservable(record('observable_gauge', name, options));
    },
    createObservableCounter(): ObservableCounter {
      return noopObservable(record('counter', 'unused', undefined));
    },
    createObservableUpDownCounter(): ObservableUpDownCounter {
      return noopObservable(record('counter', 'unused', undefined));
    },
    addBatchObservableCallback(_callback: BatchObservableCallback): void {
      // Not used by the mirror.
    },
    removeBatchObservableCallback(_callback: BatchObservableCallback): void {
      // Not used by the mirror.
    },
  };

  /** Runs every registered observable callback and returns what it observed. */
  function observeAll(name: string): { value: number; attributes: Attributes | undefined }[] {
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
  }

  return {
    meter,
    instruments,
    find: (name: string) => instruments.find((instrument) => instrument.name === name),
    observeAll,
  };
}
