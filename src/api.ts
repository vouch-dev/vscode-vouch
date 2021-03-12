// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExtensionContext } from "vscode";
import {
  endCurrentCodeTour,
  exportTour,
  onDidEndTour,
  recordTour,
  selectTour,
  startCodeTour
} from "./store/actions";

export function initializeApi(context: ExtensionContext) {
  return {
    endCurrentTour: endCurrentCodeTour,
    exportTour,
    onDidEndTour,
    recordTour,
    startTour: startCodeTour,
    selectTour
  };
}
