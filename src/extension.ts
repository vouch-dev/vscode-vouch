// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as vscode from "vscode";
import { initializeApi } from "./api";
import { registerCommands } from "./commands";
import { registerFileSystemProvider } from "./fileSystem";
import { registerTextDocumentContentProvider } from "./fileSystem/documentProvider";
import { initializeGitApi } from "./git";
import { registerLiveShareModule } from "./liveShare";
import { registerDecorators } from "./player/decorator";
import { registerStatusBar } from "./player/status";
import { registerCompletionProvider } from "./recorder/completionProvider";
import { store } from "./store";
import { discoverTours } from "./store/provider";
import { initializeStorage } from "./store/storage";
import { startCodeTour } from "./store/actions";
import { registerTreeProvider } from "./tree";
import { updateMarkerTitles, getWorkspaceUri } from "./utils";

export async function activate(context: vscode.ExtensionContext) {
  registerCommands();
  initializeStorage(context);

  // If the user has a workspace open, then attempt to discover
  // the tours contained within it and optionally prompt the user.
  if (vscode.workspace.workspaceFolders) {
    await discoverTours();

    registerDecorators();

    store.showMarkers = vscode.workspace
      .getConfiguration("vouch")
      .get("showMarkers", true);

    vscode.commands.executeCommand(
      "setContext",
      "vouch:showingMarkers",
      store.showMarkers
    );

    // Start primary review in edit mode.
    if (store.hasTours) {
      const primary_tours = store.tours.filter(tour => tour.isPrimary);
      if (primary_tours.length >= 1) {
        const tour = primary_tours[0];
        startCodeTour(
          store.tours[0],
          0,
          getWorkspaceUri(tour),
          true,
          true,
          store.tours
        )
      }
    }

    initializeGitApi();

    registerLiveShareModule();
  }

  // Regardless if the user has a workspace open,
  // we still need to register the following items
  // in order to support opening tour files and/or
  // enabling other extensions to start a tour.
  registerTreeProvider(context.extensionPath);
  registerFileSystemProvider();
  registerTextDocumentContentProvider();
  registerStatusBar();
  registerCompletionProvider();

  updateMarkerTitles();

  return initializeApi(context);
}
