/**
 * Kills only Node/tsx processes that belong to this specific project.
 * Uses Win32_Process.CommandLine to filter by project path.
 */
import { execSync } from 'child_process';

const projectPath = process.cwd();
const escapedPath = projectPath.replace(/\\/g, '\\\\');

// PowerShell command to find processes by CommandLine containing project path
const psCommand = `
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='tsx.exe'" | 
Where-Object { $_.CommandLine -like '*${escapedPath}*' } | 
Select-Object -ExpandProperty ProcessId
`;

try {
  const output = execSync(
    `powershell -NoProfile -Command "${psCommand.replace(/\n/g, ' ')}"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
  );

  const pids = output.trim().split('\n').filter(Boolean);

  if (pids.length === 0) {
    console.log('✓ No slack-llm-runner processes found running');
    process.exit(0);
  }

  let killedCount = 0;
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid.trim()} 2>nul`, { stdio: 'ignore' });
      console.log(`✓ Killed process ${pid.trim()}`);
      killedCount++;
    } catch (e) {
      // Process may have already exited
    }
  }

  console.log(`✓ Killed ${killedCount} project-specific process(es)`);
  
  // Small delay to ensure sockets close
  if (killedCount > 0) {
    execSync('powershell -Command "Start-Sleep -Milliseconds 500"');
  }
} catch (e) {
  // No processes found or other error - this is fine
  console.log('✓ No project processes to kill');
}
