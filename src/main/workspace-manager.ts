import { execFile } from 'child_process';
import type { WorkspaceConfig, WorkspaceInfo, WorkspacePodInfo } from '../shared/types';

export type { WorkspaceInfo, WorkspacePodInfo };

function kctl(context: string | undefined, ...args: string[]): string[] {
  return context ? ['--context', context, ...args] : args;
}

export function workspaceNamespace(devName: string): string {
  return `dev-${devName}`;
}

export function workspacePodName(projectName: string): string {
  return `ws-${projectName}-0`;
}

function getNamespacePods(namespace: string, context?: string): Promise<WorkspaceInfo | null> {
  const devName = namespace.replace(/^dev-/, '');
  return new Promise((resolve) => {
    execFile(
      'kubectl', kctl(context, 'get', 'pods', '-n', namespace, '-o', 'json'),
      { env: process.env, timeout: 10000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const data = JSON.parse(stdout);
          const pods: WorkspacePodInfo[] = (data.items ?? [])
            .filter((p: any) => (p.metadata?.name ?? '').startsWith('ws-'))
            .map((p: any) => {
              const podName: string = p.metadata.name;
              const projectName = podName.replace(/^ws-/, '').replace(/-\d+$/, '');
              const ready = p.status?.phase === 'Running';
              return { projectName, podName, ready };
            });
          resolve({ devName, namespace, pods });
        } catch { resolve(null); }
      }
    );
  });
}

export function listWorkspaces(context?: string): Promise<WorkspaceInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'kubectl', kctl(context, 'get', 'namespaces', '-l', 'workspace=developer', '-o', 'json'),
      { env: process.env, timeout: 10000 },
      async (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const data = JSON.parse(stdout);
          const namespaces: string[] = (data.items ?? []).map((ns: any) => ns.metadata?.name as string).filter(Boolean);
          const results = await Promise.all(namespaces.map(ns => getNamespacePods(ns, context)));
          resolve(results.filter((r): r is WorkspaceInfo => r !== null));
        } catch { resolve([]); }
      }
    );
  });
}

export function getPodStatus(devName: string, projectName: string, context?: string): Promise<'running' | 'stopped' | 'unknown'> {
  const namespace = workspaceNamespace(devName);
  const podName = workspacePodName(projectName);
  return new Promise((resolve) => {
    execFile(
      'kubectl', kctl(context, 'get', 'pod', podName, '-n', namespace, '-o', 'jsonpath={.status.phase}'),
      { env: process.env, timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve('unknown'); return; }
        const phase = stdout.trim();
        if (phase === 'Running') resolve('running');
        else if (phase === '') resolve('stopped');
        else resolve('unknown');
      }
    );
  });
}

export function scalePod(devName: string, projectName: string, replicas: number, context?: string): Promise<void> {
  const namespace = workspaceNamespace(devName);
  const statefulset = `ws-${projectName}`;
  return new Promise((resolve, reject) => {
    execFile(
      'kubectl', kctl(context, 'scale', 'statefulset', statefulset, '-n', namespace, `--replicas=${replicas}`),
      { env: process.env, timeout: 15000 },
      (err) => { err ? reject(err) : resolve(); }
    );
  });
}

export function waitForPod(devName: string, projectName: string, timeoutMs = 120000, context?: string): Promise<void> {
  const namespace = workspaceNamespace(devName);
  const podName = workspacePodName(projectName);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() > deadline) { reject(new Error('Timed out waiting for pod')); return; }
      execFile(
        'kubectl', kctl(context, 'get', 'pod', podName, '-n', namespace, '-o', 'jsonpath={.status.phase}'),
        { env: process.env, timeout: 5000 },
        (err, stdout) => {
          if (!err && stdout.trim() === 'Running') { resolve(); return; }
          setTimeout(poll, 3000);
        }
      );
    };
    poll();
  });
}

export function buildWorkspaceKubectlArgs(
  workspace: WorkspaceConfig,
  tmuxSessionName: string,
): string[] {
  const namespace = workspaceNamespace(workspace.devName);
  const podName = workspacePodName(workspace.projectName);
  const cwd = workspace.remoteFolder || '/workspace';
  return kctl(
    workspace.kubectlContext,
    'exec', '-it', podName, '-n', namespace, '--',
    'tmux', '-S', '/workspace/.tmux.sock',
    'new-session', '-A', '-s', tmuxSessionName,
    '-c', cwd,
  );
}
