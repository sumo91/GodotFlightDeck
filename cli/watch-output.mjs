import { StringDecoder } from 'node:string_decoder';

// Retain bounded unfinished lines independently for stdout and stderr.
export function watchOutput(emit) {
  let hasErrors = false;
  const streams = new Map();
  const consume = (name, text) => {
    const state = streams.get(name);
    hasErrors ||= /SCRIPT ERROR|Parse Error|ERROR:|FATAL:/.test(state.tail + text);
    state.tail = (state.tail + text).slice(-32);
    state.pending += text;
    let newline;
    while ((newline = state.pending.indexOf('\n')) >= 0) {
      emit(name, state.pending.slice(0, newline).replace(/\r$/, '').slice(0, 8192));
      state.pending = state.pending.slice(newline + 1);
    }
    if (state.pending.length > 8192) {
      emit(name, state.pending.slice(0, 8192) + ' [line truncated]');
      state.pending = state.pending.slice(-32);
    }
  };
  return {
    write(name, bytes) {
      if (!streams.has(name)) streams.set(name, { decoder: new StringDecoder('utf8'), pending: '', tail: '' });
      consume(name, streams.get(name).decoder.write(bytes));
    },
    finish() {
      for (const [name, state] of streams) {
        consume(name, state.decoder.end());
        if (state.pending) emit(name, state.pending);
      }
      return hasErrors;
    },
  };
}
