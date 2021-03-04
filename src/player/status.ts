// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "../constants";
import { store } from "../store";
import { getTourTitle } from "../utils";

function createCurrentTourItem() {
  const currentTourItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );

  currentTourItem.command = `${EXTENSION_NAME}.resumeTour`;
  currentTourItem.color = new vscode.ThemeColor(
    "statusBarItem.prominentForeground"
  );

  currentTourItem.show();
  return currentTourItem;
}

let currentTourItem: vscode.StatusBarItem | null = null;
export function registerStatusBar() {
  reaction(
    // @ts-ignore
    () => [
      store.activeTour
        ? [
          store.activeTour.step,
          store.activeTour.review.title,
          store.activeTour.review.comments.length
        ]
        : null,
      store.isRecording
    ],
    () => {
      if (store.activeTour) {
        if (!currentTourItem) {
          currentTourItem = createCurrentTourItem();
        }

        const prefix = store.isRecording ? "Recording " : "";
        const tourTitle = getTourTitle(store.activeTour.review);

        currentTourItem.text = `${prefix}Vouch: #${store.activeTour.step + 1
          } of ${store.activeTour.review.comments.length} (${tourTitle})`;
      } else {
        if (currentTourItem) {
          currentTourItem.dispose();
          currentTourItem = null;
        }
      }
    }
  );
}
