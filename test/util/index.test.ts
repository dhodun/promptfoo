import * as fs from 'fs';
import { globSync } from 'glob';
import * as path from 'path';
import cliState from '../../src/cliState';
import { getDb } from '../../src/database';
import { importModule } from '../../src/esm';
import * as googleSheets from '../../src/googleSheets';
import Eval from '../../src/models/eval';
import { runPython } from '../../src/python/pythonUtils';
import {
  ResultFailureReason,
  type ApiProvider,
  type EvaluateResult,
  type TestCase,
} from '../../src/types';
import {
  maybeLoadFromExternalFile,
  maybeLoadToolsFromExternalFile,
  parsePathOrGlob,
  providerToIdentifier,
  readFilters,
  readOutput,
  resultIsForTestCase,
  varsMatch,
  writeMultipleOutputs,
  writeOutput,
} from '../../src/util';
import { TestGrader } from './utils';

jest.mock('../../src/database', () => ({
  getDb: jest.fn(),
}));

jest.mock('proxy-agent', () => ({
  ProxyAgent: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('glob', () => ({
  globSync: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('../../src/esm', () => ({
  getDirectory: jest.fn().mockReturnValue('/test/dir'),
  importModule: jest.fn(),
}));

jest.mock('../../src/python/pythonUtils', () => ({
  runPython: jest.fn(),
}));

jest.mock('../../src/googleSheets', () => ({
  writeCsvToGoogleSheet: jest.fn(),
}));

describe('maybeLoadFromExternalFile', () => {
  const mockFileContent = 'test content';
  const mockJsonContent = '{"key": "value"}';
  const mockYamlContent = 'key: value';

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(fs.readFileSync).mockReturnValue(mockFileContent);
  });

  it('should return the input if it is not a string', async () => {
    const input = { key: 'value' };
    await expect(maybeLoadFromExternalFile(input)).resolves.toBe(input);
  });

  it('should return the input if it does not start with "file://"', async () => {
    const input = 'not a file path';
    await expect(maybeLoadFromExternalFile(input)).resolves.toBe(input);
  });

  it('should throw an error if the file does not exist', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(false);
    await expect(maybeLoadFromExternalFile('file://nonexistent.txt')).rejects.toThrow(
      'File does not exist',
    );
  });

  it('should return the file contents for a non-JSON, non-YAML file', async () => {
    await expect(maybeLoadFromExternalFile('file://test.txt')).resolves.toBe(mockFileContent);
  });

  it('should parse and return JSON content for a .json file', async () => {
    jest.mocked(fs.readFileSync).mockReturnValue(mockJsonContent);
    await expect(maybeLoadFromExternalFile('file://test.json')).resolves.toEqual({ key: 'value' });
  });

  it('should parse and return YAML content for a .yaml file', async () => {
    jest.mocked(fs.readFileSync).mockReturnValue(mockYamlContent);
    await expect(maybeLoadFromExternalFile('file://test.yaml')).resolves.toEqual({ key: 'value' });
  });

  it('should parse and return YAML content for a .yml file', async () => {
    jest.mocked(fs.readFileSync).mockReturnValue(mockYamlContent);
    await expect(maybeLoadFromExternalFile('file://test.yml')).resolves.toEqual({ key: 'value' });
  });

  it('should use basePath when resolving file paths', async () => {
    const basePath = '/base/path';
    cliState.basePath = basePath;
    jest.mocked(fs.readFileSync).mockReturnValue(mockFileContent);

    await maybeLoadFromExternalFile('file://test.txt');

    const expectedPath = path.resolve(basePath, 'test.txt');
    expect(fs.existsSync).toHaveBeenCalledWith(expectedPath);
    expect(fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf8');

    cliState.basePath = undefined;
  });

  it('should handle relative paths correctly', async () => {
    const basePath = './relative/path';
    cliState.basePath = basePath;
    jest.mocked(fs.readFileSync).mockReturnValue(mockFileContent);

    await maybeLoadFromExternalFile('file://test.txt');

    const expectedPath = path.resolve(basePath, 'test.txt');
    expect(fs.existsSync).toHaveBeenCalledWith(expectedPath);
    expect(fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf8');

    cliState.basePath = undefined;
  });

  it('should handle a path with environment variables in Nunjucks template', async () => {
    process.env.TEST_ROOT_PATH = '/root/dir';
    const input = 'file://{{ env.TEST_ROOT_PATH }}/test.txt';

    jest.mocked(fs.existsSync).mockReturnValue(true);

    const expectedPath = path.resolve(`${process.env.TEST_ROOT_PATH}/test.txt`);
    await maybeLoadFromExternalFile(input);

    expect(fs.existsSync).toHaveBeenCalledWith(expectedPath);
    expect(fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf8');

    delete process.env.TEST_ROOT_PATH;
  });

  it('should ignore basePath when file path is absolute', async () => {
    const basePath = '/base/path';
    cliState.basePath = basePath;
    jest.mocked(fs.readFileSync).mockReturnValue(mockFileContent);

    await maybeLoadFromExternalFile('file:///absolute/path/test.txt');

    const expectedPath = path.resolve('/absolute/path/test.txt');
    expect(fs.existsSync).toHaveBeenCalledWith(expectedPath);
    expect(fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf8');

    cliState.basePath = undefined;
  });

  it('should handle list of paths', async () => {
    const basePath = './relative/path';
    cliState.basePath = basePath;
    jest.mocked(fs.readFileSync).mockReturnValue(mockJsonContent);

    await maybeLoadFromExternalFile(['file://test1.txt', 'file://test2.txt', 'file://test3.txt']);

    expect(fs.existsSync).toHaveBeenCalledTimes(3);
    expect(fs.existsSync).toHaveBeenNthCalledWith(1, path.resolve(basePath, 'test1.txt'));
    expect(fs.existsSync).toHaveBeenNthCalledWith(2, path.resolve(basePath, 'test2.txt'));
    expect(fs.existsSync).toHaveBeenNthCalledWith(3, path.resolve(basePath, 'test3.txt'));

    cliState.basePath = undefined;
  });

  it('should load a JavaScript module that returns a function and execute it', async () => {
    const mockFunctionResult = { key: 'function result value' };
    const mockFunction = jest.fn().mockResolvedValue(mockFunctionResult);
    
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(importModule).mockResolvedValue(mockFunction);
    
    const result = await maybeLoadFromExternalFile('file://test-function.js');
    expect(result).toEqual(mockFunctionResult);
  });

  it('should read JS file and return the data', async () => {
    const mockData = [
      { vars: { var1: 'value1', var2: 'value2' } },
      { vars: { var1: 'value3', var2: 'value4' } },
    ];
    
    jest.mocked(importModule).mockReset();
    jest.mocked(importModule).mockImplementation(async (modulePath) => {
      if (String(modulePath).endsWith('test.js')) {
        return mockData;
      }
      throw new Error(`Unexpected path: ${modulePath}`);
    });
    
    jest.mocked(fs.existsSync).mockReturnValue(true);

    const result = await maybeLoadFromExternalFile('file://test.js');
    expect(result).toEqual(mockData);
  });
  
  it('should load a JavaScript module and execute a named function', async () => {
    const mockFunctionResult = 'named function result';
    const mockNamedFunction = jest.fn().mockReturnValue(mockFunctionResult);
    
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(importModule).mockResolvedValue(mockNamedFunction);
    
    const result = await maybeLoadFromExternalFile('file://test-module.js:namedFunction');
    expect(result).toEqual(mockFunctionResult);
  });
  
  it('should load a Python script with a specific function name', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(true);
    const mockPythonResult = { data: 'python script result' };
    jest.mocked(runPython).mockResolvedValue(mockPythonResult);
    
    const result = await maybeLoadFromExternalFile('file://test-script.py:get_data');
    
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining('test-script.py'));
    expect(runPython).toHaveBeenCalledWith(
      expect.stringContaining('test-script.py'), 
      'get_data',
      []
    );
    await expect(Promise.resolve(result)).resolves.toEqual(mockPythonResult);
  });
  
  it('should throw an error when no function name or default function is provided for Python files', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(true);
    
    await expect(maybeLoadFromExternalFile('file://test-script.py'))
      .rejects.toThrow(/No function name available for Python file/);
  });
  
  it('should handle null and undefined inputs properly', async () => {
    await expect(maybeLoadFromExternalFile(null)).resolves.toBeNull();
    await expect(maybeLoadFromExternalFile(undefined)).resolves.toBeUndefined();
  });
});

describe('maybeLoadToolsFromExternalFile', () => {
  const mockFileContent = 'test content';

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(fs.readFileSync).mockReturnValue(mockFileContent);
  });
  
  it('should call maybeLoadFromExternalFile with get_tools as the default function name', async () => {
    const mockValue = { test: 'data' };
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockValue));
    
    const result = await maybeLoadToolsFromExternalFile('file://test.json');
    
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining('test.json'));
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('test.json'), 'utf8');
    await expect(Promise.resolve(result)).resolves.toEqual(mockValue);
  });
  
  it('should load tools from a JavaScript file that implements get_tools', async () => {
    const mockTools = [
      { name: 'tool1', description: 'First tool' },
      { name: 'tool2', description: 'Second tool' }
    ];
    
    const mockGetToolsFunction = jest.fn().mockReturnValue(mockTools);
    jest.mocked(fs.existsSync).mockReturnValue(true);
    jest.mocked(importModule).mockResolvedValue(mockGetToolsFunction);
    
    const result = await maybeLoadToolsFromExternalFile('file://tools.js');
    expect(result).toEqual(mockTools);
  });
  
  it('should load tools from a Python file that implements get_tools', async () => {
    jest.mocked(fs.existsSync).mockReturnValue(true);
    
    const mockPythonTools = [
      { name: 'python_tool1', description: 'Python tool 1' },
      { name: 'python_tool2', description: 'Python tool 2' }
    ];
    
    jest.mocked(runPython).mockResolvedValue(mockPythonTools);
    
    const result = await maybeLoadToolsFromExternalFile('file://tools.py');
    
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining('tools.py'));
    expect(runPython).toHaveBeenCalledWith(
      expect.stringContaining('tools.py'), 
      'get_tools',
      []
    );
    await expect(Promise.resolve(result)).resolves.toEqual(mockPythonTools);
  });
});

describe('util', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('writeOutput', () => {
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      // @ts-ignore
      jest.mocked(getDb).mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });
    it('writeOutput with CSV output', async () => {
      // @ts-ignore
      jest.mocked(getDb).mockReturnValue({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });
      const outputPath = 'output.csv';
      const results: EvaluateResult[] = [
        {
          success: true,
          failureReason: ResultFailureReason.NONE,
          score: 1.0,
          namedScores: {},
          latencyMs: 1000,
          provider: {
            id: 'foo',
          },
          prompt: {
            raw: 'Test prompt',
            label: '[display] Test prompt',
          },
          response: {
            output: 'Test output',
          },
          vars: {
            var1: 'value1',
            var2: 'value2',
          },
          promptIdx: 0,
          testIdx: 0,
          testCase: {},
          promptId: 'foo',
        },
      ];
      const eval_ = new Eval({});
      await eval_.addResult(results[0]);

      const shareableUrl = null;
      await writeOutput(outputPath, eval_, shareableUrl);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('writeOutput with JSON output', async () => {
      const outputPath = 'output.json';
      const eval_ = new Eval({});
      await writeOutput(outputPath, eval_, null);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('writeOutput with YAML output', async () => {
      const outputPath = 'output.yaml';
      const eval_ = new Eval({});
      await writeOutput(outputPath, eval_, null);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    it('writeOutput with json and txt output', async () => {
      const outputPath = ['output.json', 'output.txt'];
      const eval_ = new Eval({});

      await writeMultipleOutputs(outputPath, eval_, null);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    });

    it('writes output to Google Sheets', async () => {
      const outputPath = 'https://docs.google.com/spreadsheets/d/1234567890/edit#gid=0';

      const config = { description: 'Test config' };
      const shareableUrl = null;
      const eval_ = new Eval(config);

      await writeOutput(outputPath, eval_, shareableUrl);

      expect(googleSheets.writeCsvToGoogleSheet).toHaveBeenCalledTimes(1);
    });
  });

  describe('readOutput', () => {
    it('reads JSON output', async () => {
      const outputPath = 'output.json';
      jest.mocked(fs.readFileSync).mockReturnValue('{}');
      const output = await readOutput(outputPath);
      expect(output).toEqual({});
    });

    it('fails for csv output', async () => {
      await expect(readOutput('output.csv')).rejects.toThrow(
        'Unsupported output file format: csv currently only supports json',
      );
    });

    it('fails for yaml output', async () => {
      await expect(readOutput('output.yaml')).rejects.toThrow(
        'Unsupported output file format: yaml currently only supports json',
      );

      await expect(readOutput('output.yml')).rejects.toThrow(
        'Unsupported output file format: yml currently only supports json',
      );
    });
  });

  it('readFilters', async () => {
    const mockFilter = jest.fn();

    // Mock globSync to return the filter path
    jest.mocked(globSync).mockImplementation((pathOrGlob) => [pathOrGlob].flat());

    // Mock importModule to return our mock filter
    jest.mocked(importModule).mockResolvedValue(mockFilter);

    // Call the function we're testing
    const filters = await readFilters({ testFilter: 'filter.js' });

    // Verify correct behavior
    expect(importModule).toHaveBeenCalledWith(expect.stringContaining('filter.js'));
    expect(filters.testFilter).toBe(mockFilter);
  });

  describe('providerToIdentifier', () => {
    it('works with string', () => {
      const provider = 'openai:gpt-4';

      expect(providerToIdentifier(provider)).toStrictEqual(provider);
    });

    it('works with provider id undefined', () => {
      expect(providerToIdentifier(undefined)).toBeUndefined();
    });

    it('works with ApiProvider', () => {
      const providerId = 'custom';
      const apiProvider = {
        id() {
          return providerId;
        },
      } as ApiProvider;

      expect(providerToIdentifier(apiProvider)).toStrictEqual(providerId);
    });

    it('works with ProviderOptions', () => {
      const providerId = 'custom';
      const providerOptions = {
        id: providerId,
      };

      expect(providerToIdentifier(providerOptions)).toStrictEqual(providerId);
    });
  });

  describe('varsMatch', () => {
    it('true with both undefined', () => {
      expect(varsMatch(undefined, undefined)).toBe(true);
    });

    it('false with one undefined', () => {
      expect(varsMatch(undefined, {})).toBe(false);
      expect(varsMatch({}, undefined)).toBe(false);
    });
  });

  describe('resultIsForTestCase', () => {
    const testCase: TestCase = {
      provider: 'provider',
      vars: {
        key: 'value',
      },
    };
    const result = {
      provider: 'provider',
      vars: {
        key: 'value',
      },
    } as any as EvaluateResult;

    it('is true', () => {
      expect(resultIsForTestCase(result, testCase)).toBe(true);
    });

    it('is false if provider is different', () => {
      const nonMatchTestCase: TestCase = {
        provider: 'different',
        vars: {
          key: 'value',
        },
      };

      expect(resultIsForTestCase(result, nonMatchTestCase)).toBe(false);
    });

    it('is false if vars are different', () => {
      const nonMatchTestCase: TestCase = {
        provider: 'provider',
        vars: {
          key: 'different',
        },
      };

      expect(resultIsForTestCase(result, nonMatchTestCase)).toBe(false);
    });
  });

  describe('parsePathOrGlob', () => {
    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should parse a simple file path with extension', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'file.txt')).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: path.join('/base', 'file.txt'),
      });
    });

    it('should parse a file path with function name', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'file.py:myFunction')).toEqual({
        extension: '.py',
        functionName: 'myFunction',
        isPathPattern: false,
        filePath: path.join('/base', 'file.py'),
      });
    });

    it('should parse a Go file path with function name', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'script.go:CallApi')).toEqual({
        extension: '.go',
        functionName: 'CallApi',
        isPathPattern: false,
        filePath: path.join('/base', 'script.go'),
      });
    });

    it('should parse a directory path', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as fs.Stats);
      expect(parsePathOrGlob('/base', 'dir')).toEqual({
        extension: undefined,
        functionName: undefined,
        isPathPattern: true,
        filePath: path.join('/base', 'dir'),
      });
    });

    it('should handle non-existent file path gracefully when PROMPTFOO_STRICT_FILES is false', () => {
      jest.spyOn(fs, 'statSync').mockImplementation(() => {
        throw new Error('File does not exist');
      });
      expect(parsePathOrGlob('/base', 'nonexistent.js')).toEqual({
        extension: '.js',
        functionName: undefined,
        isPathPattern: false,
        filePath: path.join('/base', 'nonexistent.js'),
      });
    });

    it('should throw an error for non-existent file path when PROMPTFOO_STRICT_FILES is true', () => {
      process.env.PROMPTFOO_STRICT_FILES = 'true';
      jest.spyOn(fs, 'statSync').mockImplementation(() => {
        throw new Error('File does not exist');
      });
      expect(() => parsePathOrGlob('/base', 'nonexistent.js')).toThrow('File does not exist');
      delete process.env.PROMPTFOO_STRICT_FILES;
    });

    it('should return empty extension for files without extension', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'file')).toEqual({
        extension: '',
        functionName: undefined,
        isPathPattern: false,
        filePath: path.join('/base', 'file'),
      });
    });

    it('should handle relative paths', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('./base', 'file.txt')).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: path.join('./base', 'file.txt'),
      });
    });

    it('should handle paths with environment variables', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      process.env.FILE_PATH = 'file.txt';
      expect(parsePathOrGlob('/base', process.env.FILE_PATH)).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: path.join('/base', 'file.txt'),
      });
      delete process.env.FILE_PATH;
    });

    it('should handle glob patterns in file path', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', '*.js')).toEqual({
        extension: undefined,
        functionName: undefined,
        isPathPattern: true,
        filePath: path.join('/base', '*.js'),
      });
    });

    it('should handle complex file paths', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'dir/subdir/file.py:func')).toEqual({
        extension: '.py',
        functionName: 'func',
        isPathPattern: false,
        filePath: path.join('/base', 'dir/subdir/file.py'),
      });
    });

    it('should handle non-standard file extensions', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'file.customext')).toEqual({
        extension: '.customext',
        functionName: undefined,
        isPathPattern: false,
        filePath: path.join('/base', 'file.customext'),
      });
    });

    it('should handle deeply nested file paths', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'a/b/c/d/e/f/g/file.py:func')).toEqual({
        extension: '.py',
        functionName: 'func',
        isPathPattern: false,
        filePath: path.join('/base', 'a/b/c/d/e/f/g/file.py'),
      });
    });

    it('should handle complex directory paths', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as fs.Stats);
      expect(parsePathOrGlob('/base', 'a/b/c/d/e/f/g')).toEqual({
        extension: undefined,
        functionName: undefined,
        isPathPattern: true,
        filePath: path.join('/base', 'a/b/c/d/e/f/g'),
      });
    });

    it('should join basePath and safeFilename correctly', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      const basePath = 'base';
      const relativePath = 'relative/path/to/file.txt';
      expect(parsePathOrGlob(basePath, relativePath)).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: expect.stringMatching(/base[\\\/]relative[\\\/]path[\\\/]to[\\\/]file.txt/),
      });
    });

    it('should handle empty basePath', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('', 'file.txt')).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: 'file.txt',
      });
    });

    it('should handle file:// prefix', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('', 'file://file.txt')).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: 'file.txt',
      });
    });

    it('should handle file://./... with absolute base path', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/absolute/base', 'file://./prompts/file.txt')).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: expect.stringMatching(/^[/\\]absolute[/\\]base[/\\]prompts[/\\]file\.txt$/),
      });
    });

    it('should handle file://./... with relative base path', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('relative/base', 'file://file.txt')).toEqual({
        extension: '.txt',
        functionName: undefined,
        isPathPattern: false,
        filePath: expect.stringMatching(/^relative[/\\]base[/\\]file\.txt$/),
      });
    });

    it('should handle file:// prefix with Go function', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'file://script.go:CallApi')).toEqual({
        extension: '.go',
        functionName: 'CallApi',
        isPathPattern: false,
        filePath: path.join('/base', 'script.go'),
      });
    });

    it('should handle file:// prefix with absolute path and Go function', () => {
      jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as fs.Stats);
      expect(parsePathOrGlob('/base', 'file:///absolute/path/script.go:CallApi')).toEqual({
        extension: '.go',
        functionName: 'CallApi',
        isPathPattern: false,
        filePath: expect.stringMatching(/^[/\\]absolute[/\\]path[/\\]script\.go$/),
      });
    });
  });

  describe('Grader', () => {
    it('should have an id and callApi attributes', async () => {
      const Grader = new TestGrader();
      expect(Grader.id()).toBe('TestGradingProvider');
      await expect(Grader.callApi()).resolves.toEqual({
        output: JSON.stringify({
          pass: true,
          reason: 'Test grading output',
        }),
        tokenUsage: {
          completion: 5,
          prompt: 5,
          total: 10,
        },
      });
    });
  });
});
