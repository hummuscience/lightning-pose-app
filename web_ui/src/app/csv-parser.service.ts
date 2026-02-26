import { Injectable } from '@angular/core';
import Papa, { ParseResult } from 'papaparse';
import { Pair } from './utils/pair';
import * as dfd from 'danfojs';

@Injectable({
  providedIn: 'root',
})
export class CsvParserService {
  /**
   * Parses a CSV string from pose estimation into a 3D array (ndarray-like structure)
   * using the PapaParse library.
   * The output shape is (number of frames, number of bodyparts, 2 for x/y coordinates).
   *
   * @param csvString The CSV data as a string.
   * @returns A 3D array of numbers: number[][][].
   * Returns an empty array if the CSV is malformed, has no data, or PapaParse fails.
   */
  getBodyParts(csvString: string): string[] {
    const parseOutput: ParseResult<string[]> = Papa.parse(
      // parse the header only, for speed.
      csvString.trim().split('\n').slice(0, 4).join('\n'),
      {
        dynamicTyping: false,
        skipEmptyLines: true,
      },
    );

    if (parseOutput.errors.length > 0) {
      console.error('PapaParse errors:', parseOutput.errors);
      return [];
    }

    const allRows = parseOutput.data;

    if (allRows.length < 3) {
      console.error('CSV must have at least 3 header lines.');
      return [];
    }
    return [...new Set(allRows[1].slice(1))];
  }

  parsePredictionFile(csvString: string): dfd.DataFrame {
    const parseOutput: ParseResult<string[]> = Papa.parse(csvString.trim(), {
      dynamicTyping: false,
      skipEmptyLines: true,
    });

    if (parseOutput.errors.length > 0) {
      console.error('PapaParse errors:', parseOutput.errors);
      new dfd.DataFrame();
    }

    const allRows = parseOutput.data;

    if (allRows.length < 4) {
      console.error('CSV must have at least 3 header lines and 1 data line.');
      new dfd.DataFrame();
    }
    const dataRowsOnly = allRows.slice(3);

    const data = {} as Record<string, number[]>;
    const index = Array(dataRowsOnly.length);
    for (let i = 1; i < allRows[0].length; i++) {
      const flatColumn = new Pair(allRows[1][i], allRows[2][i]);

      data[flatColumn.toMapKey()] = new Array(dataRowsOnly.length).fill(
        NaN,
      ) as number[];
    }

    dataRowsOnly.forEach((row, rowIndex) => {
      index[rowIndex] = row[0];
      for (let i = 1; i < allRows[0].length; i++) {
        const flatColumn = new Pair(allRows[1][i], allRows[2][i]);
        const cellValue = row[i];
        const value = cellValue !== undefined ? parseFloat(cellValue) : NaN;
        data[flatColumn.toMapKey()]![rowIndex] = value;
      }
    });

    // Create the ndarray with the flat data and the desired shape
    //return ndarray(flatData, [numFrames, numBodyParts, 2]);
    return new dfd.DataFrame(data, { index });
  }

  /**
   * Parses a flat metric CSV (single header row with keypoint names, numeric data rows).
   * Used for companion metric files like *_temporal_norm.csv and *_pca_singleview_error.csv.
   */
  parseSimpleMetricFile(csvString: string): dfd.DataFrame {
    const parseOutput: ParseResult<string[]> = Papa.parse(csvString.trim(), {
      dynamicTyping: false,
      skipEmptyLines: true,
    });

    if (parseOutput.errors.length > 0) {
      console.error('PapaParse errors:', parseOutput.errors);
      return new dfd.DataFrame();
    }

    const allRows = parseOutput.data;
    if (allRows.length < 2) {
      console.error('Metric CSV must have at least 1 header line and 1 data line.');
      return new dfd.DataFrame();
    }

    const headers = allRows[0];
    const dataRows = allRows.slice(1);
    const data = {} as Record<string, number[]>;

    for (const col of headers) {
      if (col === 'set' || col === '') continue;
      data[col] = new Array(dataRows.length).fill(NaN) as number[];
    }

    dataRows.forEach((row, rowIndex) => {
      for (let i = 0; i < headers.length; i++) {
        const col = headers[i];
        if (col === 'set' || col === '') continue;
        const value = row[i] !== undefined ? parseFloat(row[i]) : NaN;
        data[col]![rowIndex] = value;
      }
    });

    return new dfd.DataFrame(data);
  }
}
