#!/usr/bin/env node

import { program } from 'commander'
import { createReadStream } from 'node:fs'
import { readdir, rename, writeFile, readFile, unlink } from 'node:fs/promises'
import { ensureDir } from 'fs-extra'
import path from 'node:path'
import inquirer from 'inquirer'
import crypto from 'node:crypto'

function calculateMD5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = createReadStream(filePath)

    stream.on('data', (data) => {
      hash.update(data)
    })

    stream.on('end', () => {
      resolve(hash.digest('hex'))
    })

    stream.on('error', (err) => {
      reject(err)
    })
  })
}

const isShishoDir = async (dir: string): Promise<boolean> => {
  const files = await readdir(dir)
  return files.includes('__SHISHO__')
}

const getID = async (dir: string): Promise<string> => {
  if (!(await isShishoDir(dir))) {
    throw new Error('Not a valid shisho directory')
  }

  const files = await readdir(dir)
  const idFile = files.find((file) => file.startsWith('id__'))
  if (!idFile) {
    throw new Error('ID file not found')
  }
  return idFile.slice('id__'.length)
}

const getVersion = async (dir: string): Promise<number> => {
  if (!(await isShishoDir(dir))) {
    throw new Error('Not a valid shisho directory')
  }

  const files = await readdir(dir)
  const verFile = files.find((file) => file.startsWith('ver__'))
  if (!verFile) {
    throw new Error('Version file not found')
  }
  return Number(verFile.slice('ver__'.length))
}

const getMD5 = async (dir: string): Promise<FileMD5[]> => {
  if (!(await isShishoDir(dir))) {
    throw new Error('Not a valid shisho directory')
  }

  const content = await readFile(
    path.join(dir, '__SHISHO__', 'md5.txt'),
    'utf-8'
  )
  return loadString(content)
}

interface FileMD5 {
  path: string
  md5: string
}

async function calculateMD5Directory(dir: string): Promise<FileMD5[]> {
  async function t(d: string): Promise<FileMD5[]> {
    const files = await readdir(path.join(dir, d), { withFileTypes: true })
    const results: FileMD5[] = []

    for (const file of files) {
      const filePath = path.join(d, file.name)

      if (file.isDirectory()) {
        const subdirResults = await t(filePath)
        results.push(...subdirResults)
      } else if (file.isFile()) {
        const md5 = await calculateMD5(path.join(dir, filePath))
        results.push({ path: filePath.replace(/\\/g, '/'), md5 })
      }
    }

    return results
  }
  return await t('')
}

const dumpString = (info: FileMD5[]): string => {
  return info.map(({ path, md5 }) => `${md5} ${path}\n`).join('')
}

const loadString = (content: string): FileMD5[] => {
  if (content.endsWith('\n')) {
    content = content.slice(0, -1)
  }

  return content.split('\n').map((line) => {
    const parts = line.split(' ')
    const md5 = parts[0]
    const path = parts.slice(1).join(' ')
    return { md5, path }
  })
}

const writeMD5 = async (dir: string, info: FileMD5[]): Promise<void> => {
  const md5Path = path.join(dir, '__SHISHO__/md5.txt')
  await writeFile(md5Path, dumpString(info), 'utf-8')
}

program
  .command('init <id> [directory]')
  .description('Initialize a new directory with the specified ID')
  .action(async (id, directory = '.') => {
    console.log(`Initializing directory: ${directory} with ID: ${id}`)
    const files = await readdir(directory)

    if (files.includes('__SHISHO__')) {
      console.log('`__SHISHO__` directory already exists. Aborted.')
      console.log(
        'If you want to reinitialize, please delete the `__SHISHO__` directory first.'
      )
      return
    }

    console.log('About to move these files:')

    for (const file of files.slice(0, 5)) {
      console.log(`- ${file}`)
    }

    if (files.length > 5) {
      console.log(`...and ${files.length - 5} more`)
    }

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'moveOn',
        message: 'Continue?',
      },
    ])

    if (!answers.moveOn) {
      console.log('Aborted')
      return
    }

    let randomDirName = ''

    while (true) {
      randomDirName = 'tmp_' + crypto.randomBytes(4).toString('hex')

      if (!files.includes(randomDirName)) {
        break
      }
    }

    const tmpDir = path.join(directory, randomDirName)
    await ensureDir(tmpDir)

    for (const file of files) {
      const source = path.join(directory, file)
      const target = path.join(tmpDir, file)
      await rename(source, target)
    }

    const dataDir = path.join(directory, 'data')
    await rename(tmpDir, dataDir)
    const shishoDir = path.join(directory, '__SHISHO__')
    await ensureDir(shishoDir)
    await writeFile(path.join(directory, `id__${id}`), '')
    await writeFile(path.join(directory, 'ver__0'), '')
    console.log('Computing MD5 of files...')
    const results = await calculateMD5Directory(dataDir)
    await writeMD5(directory, results)
    console.log('MD5 computed and saved to `__SHISHO__/md5.txt`')
  })

const fileMD5ArrayToMap = (info: FileMD5[]): Map<string, string> => {
  const map = new Map()
  for (const { path, md5 } of info) {
    map.set(path, md5)
  }
  return map
}

const isFileMD5ArrayEqual = (info1: FileMD5[], info2: FileMD5[]): boolean => {
  if (info1.length !== info2.length) {
    return false
  }
  const map1 = fileMD5ArrayToMap(info1)
  const map2 = fileMD5ArrayToMap(info2)
  if (map1.size !== map2.size) {
    return false
  }
  for (const [path, md5] of map1) {
    if (map2.get(path) !== md5) {
      return false
    }
  }
  return true
}

program
  .command('check [directory]')
  .description('Check the specified directory')
  .action(async (directory = '.') => {
    console.log(`Checking directory: ${directory}`)
    const results = await calculateMD5Directory(path.join(directory, 'data'))
    const results2 = await getMD5(directory)
    const equal = isFileMD5ArrayEqual(results, results2)
    console.log(equal ? 'All files are the same' : 'Files are different')
  })

program
  .command('update [directory]')
  .description('Update the specified directory')
  .action(async (directory = '.') => {
    console.log(`Updating directory: ${directory}`)
    const files = await readdir(directory)
    if (!files.includes('__SHISHO__')) {
      console.log('`__SHISHO__` file does not exist. Aborted.')
      return
    }
    const verFile = files.find((file) => file.startsWith('ver__'))
    if (!verFile) {
      console.log('`ver__` file does not exist. Aborted.')
      return
    }
    const version = Number(verFile.slice(5))
    const newVersion = version + 1
    await writeFile(path.join(directory, `ver__${newVersion}`), '')
    await unlink(path.join(directory, verFile))

    const results = await calculateMD5Directory(path.join(directory, 'data'))
    const content = dumpString(results)
    await writeFile(path.join(directory, 'md5.txt'), content, 'utf-8')
  })

program
  .command('compare <dir1> <dir2>')
  .description('Compare two directories')
  .action(async (dir1, dir2) => {
    console.log(`Comparing directories: ${dir1} and ${dir2}`)
    if (!(await isShishoDir(dir1)) || !(await isShishoDir(dir2))) {
      console.log('Not a valid shisho directory')
      return
    }
    const id1 = await getID(dir1)
    const id2 = await getID(dir2)
    if (id1 !== id2) {
      console.log('ID does not match')
      return
    }
    const version1 = await getVersion(dir1)
    const version2 = await getVersion(dir2)
    if (version1 !== version2) {
      console.log('Version does not match')
      return
    }
    const md51 = await getMD5(dir1)
    const md52 = await getMD5(dir2)
    const equal = isFileMD5ArrayEqual(md51, md52)
    if (!equal) {
      console.log('MD5 does not match')
      return
    }
    console.log('All files are the same')
  })

program.parse(process.argv)
