import { execFile } from 'child_process';
import type { WorkspaceConfig, WorkspaceInfo, WorkspacePodInfo } from '../shared/types';

export type { WorkspaceInfo, WorkspacePodInfo };

export function workspaceNamespace(devName: string): string {
  return `dev-${devName}`;
}

export function workspacePodName(projectName: string): string {
  return `ws-${projectName}-0`;
}

function getNamespacePods(namespace: string): Promise<WorkspaceInfo | null> {
  const devName = namespace.replace(/^dev-/, '');
  return new Promise((resolve) => {
    execFile(
      'kubectl', ['get', 'pods', '-n', namespace, '-o', 'json'],
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

export function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'kubectl', ['get', 'namespaces', '-l', 'workspace=developer', '-o', 'json'],
      { env: process.env, timeout: 10000 },
      async (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const data = JSON.parse(stdout);
          const namespaces: string[] = (data.items ?? []).map((ns: any) => ns.metadata?.name as string).filter(Boolean);
          const results = await Promise.all(namespaces.map(getNamespacePods));
          resolve(results.filter((r): r is WorkspaceInfo => r !== null));
        } catch { resolve([]); }
      }
    );
  });
}

export function getPodStatus(devName: string, projectName: string): Promise<'running' | 'stopped' | 'unknown'> {
  const namespace = workspaceNamespace(devName);
  const podName = workspacePodName(projectName);
  return new Promise((resolve) => {
    execFile(
      'kubectl', ['get', 'pod', podName, '-n', namespace, '-o', 'jsonpath={.status.phase}'],
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

export function buildWorkspaceKubectlArgs(
  workspace: WorkspaceConfig,
  tmuxSessionName: string,
): string[] {
  const namespace = workspaceNamespace(workspace.devName);
  const podName = workspacePodName(workspace.projectName);
  return [
    'exec', '-it', podName, '-n', namespace, '--',
    'tmux', '-S', '/workspace/.tmux.sock',
    'new-session', '-A', '-s', tmuxSessionName,
    '-c', '/workspace',
  ];
}
