// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { observable } from "mobx";
import { commands, ExtensionContext, Uri, workspace } from "vscode";
import { store, Review } from ".";

const CODETOUR_PROGRESS_KEY = "vouch:progress";

export var progress: {
  update(): void;
  isComplete(tour: Review, stepNumber?: number): boolean;
  reset(): void;
};

function getProgress(tour: Review) {
  const progress = store.progress.find(([id]) => tour.id === id);
  return progress?.[1] || observable([]);
}

export function initializeStorage(context: ExtensionContext) {
  store.progress = context.globalState.get(CODETOUR_PROGRESS_KEY) || [];

  progress = {
    async update() {
      const progress = store.progress.find(
        ([id]) => store.activeTour?.review.id === id
      );

      if (progress && !progress![1].includes(store.activeTour!.step)) {
        progress![1].push(store.activeTour!.step);
      } else {
        store.progress.push([
          store.activeTour!.review.id,
          [store.activeTour!.step]
        ]);
      }

      commands.executeCommand("setContext", "vouch:hasProgress", true);
      return context.globalState.update(CODETOUR_PROGRESS_KEY, store.progress);
    },
    isComplete(tour: Review, stepNumber?: number): boolean {
      const tourProgress = getProgress(tour);
      if (stepNumber !== undefined) {
        return tourProgress.includes(stepNumber);
      } else {
        return tourProgress.length >= tour.comments.length;
      }
    },
    async reset(tour?: Review) {
      commands.executeCommand("setContext", "vouch:hasProgress", false);

      store.progress = tour
        ? store.progress.filter(tourProgress => tourProgress[0] !== tour.id)
        : [];
      return context.globalState.update(CODETOUR_PROGRESS_KEY, store.progress);
    }
  };

  // @ts-ignore
  context.globalState.setKeysForSync([CODETOUR_PROGRESS_KEY]);

  const workspaceHasProgress = store.progress.some(([id]) =>
    workspace.getWorkspaceFolder(Uri.parse(id))
  );

  if (workspaceHasProgress) {
    commands.executeCommand("setContext", "vouch:hasProgress", true);
  }
}
