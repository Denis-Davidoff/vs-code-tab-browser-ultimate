/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A `.csv` bundled as text by esbuild (`loader: { '.csv': 'text' }` in esbuild.webview.mts). */
declare module '*.csv' {
	const text: string;
	export default text;
}
