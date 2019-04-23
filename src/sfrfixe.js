const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')
const { log } = require('cozy-konnector-libs')

module.exports = function parseFixeBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client.sfr.fr'

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
      fileurl: `${baseURL}${firstBillUrl}`
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
            fileurl: `${baseURL}${fileurl}`
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
