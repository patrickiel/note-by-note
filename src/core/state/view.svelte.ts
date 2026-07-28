export type View = 'workspace' | 'settings' | 'library' | 'help';

/** Which overlay is on top of the workspace. */
class ViewStore {
  current = $state<View>('workspace');

  open(view: View) {
    this.current = view;
  }

  close() {
    this.current = 'workspace';
  }
}

export const view = new ViewStore();
