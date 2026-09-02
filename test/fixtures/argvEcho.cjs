// Synthetic test "CLI binary": tolerates any flags, writes noise to stderr and
// a JSON array of its own argv to stdout. Used to assert capture-mode stream
// separation and spawnArgs flag construction without depending on a real CLI.
process.stderr.write('NOISE-STDERR\n');
process.stdout.write(JSON.stringify(process.argv.slice(2)));
