const FLAG_KEYS = {
  '--query': 'query',
  '-q': 'query',
  '--category': 'category',
  '-c': 'category',
  '--sort': 'sort',
  '-s': 'sort',
  '--version': 'version',
  '--name': 'name',
};

export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  const options = { query: '', category: '', sort: '-download_count', version: undefined, name: undefined };
  let index = 0;
  while (index < args.length) {
    const key = FLAG_KEYS[args[index]];
    if (!key) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value == null || Object.hasOwn(FLAG_KEYS, value)) {
      throw new Error(`Missing value for ${args[index]}`);
    }
    options[key] = value;
    args.splice(index, 2);
  }

  return { command, positional: args, options };
}
