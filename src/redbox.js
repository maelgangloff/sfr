const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')
const { log, cozyClient } = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

module.exports = function parseRedBoxBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client-red.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('#lastFacture')
  const firstBillUrl = $firstBill.find('a.sr-chevron').attr('href')

  if (firstBillUrl) {
    const fields = $firstBill
      .find('.sr-container-content')
      .eq(0)
      .find('span')
    const firstBillDate = moment(
      fields
        .eq(1)
        .text()
        .trim(),
      'DD/MM/YYYY'
    )
    const price = fields
      .eq(2)
      .text()
      .trim()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`,
      filename: getFileName(firstBillDate),
      vendor: 'SFR RED BOX',
      metadata: {
        contentAuthor: 'red-by-sfr.fr',
        issueDate: firstBillDate,
        datetime: new Date(),
        datetimeLabel: `issueDate`,
        isSubscription: true,
        carbonCopy: true,
        qualification: Qualification.getByLabel('isp_invoice')
      }
    }

    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  return bluebird
    .mapSeries(Array.from($('table.sr-multi-payment tbody tr')), tr => {
      let link = $(tr)
        .find('td')
        .eq(1)
        .find('a')
      if (link.length === 1) {
        link = baseURL + link.attr('href')
        return this.request(link).then($ =>
          $('.sr-container-wrapper-m')
            .eq(0)
            .html()
        )
      } else {
        return false
      }
    })
    .then(list => list.filter(item => item))
    .then(list =>
      list.map(item => {
        const $ = cheerio.load(item)
        const fileurl = $('a.sr-chevron').attr('href')
        const fields = $('.sr-container-box-M')
          .eq(0)
          .find('span')
        const date = moment(
          fields
            .eq(1)
            .text()
            .trim(),
          'DD/MM/YYYY'
        )
        const price = fields
          .eq(2)
          .text()
          .trim()
          .replace('€', '')
          .replace(',', '.')
        if (price) {
          const bill = {
            date: date.toDate(),
            amount: parseFloat(price),
            fileurl: `${baseURL}${fileurl}`,
            filename: getFileName(date),
            vendor: 'SFR RED BOX',
            metadata: {
              contentAuthor: 'red-by-sfr.fr',
              issueDate: date.toDate(),
              datetime: new Date(),
              datetimeLabel: `issueDate`,
              isSubscription: true,
              carbonCopy: true,
              qualification: Qualification.getByLabel('isp_invoice')
            }
          }
          return bill
        } else return null
      })
    )
    .then(list => list.filter(item => item))
    .then(bills => {
      if (result.length) bills.unshift(result[0])
      return bills
    })
}

function getFileName(date) {
  return `${date.format('YYYY_MM')}_SfrRed.pdf`
}
